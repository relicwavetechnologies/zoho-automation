import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { ensureDivoTeachConversation } from '@/lib/divo-teach-thread'
import {
  finalizeLocalTeachRecording,
  getTeachSession,
  isTeachUploadActive,
  listLocalTeachRecordings,
  uploadTeachRecording,
  type TeachLocalRecording,
} from '@/lib/divo-teach'

const RECONCILE_INTERVAL_MS = 2_500

function isMainWindow() {
  try {
    return getCurrentWebviewWindow().label === 'main'
  } catch {
    return true
  }
}

/**
 * App-level owner for durable Teach work.
 *
 * Route components may come and go while a recording uploads or the backend
 * extracts evidence. This reconciler reads the native recording sidecars,
 * resumes an interrupted upload after a webview refresh, and creates the
 * normal Teach chat as soon as evidence is ready. Interactive reasoning still
 * begins when the manager opens that persisted chat, where clarification cards
 * and tool activity remain visible.
 */
export function TeachReliabilityProvider() {
  const announcedSessions = useRef(new Set<string>())
  const settledSessions = useRef(new Set<string>())

  useEffect(() => {
    if (!IS_TAURI || !isMainWindow()) return

    let active = true
    let timer: number | undefined

    const reconcileRecording = async (recording: TeachLocalRecording) => {
      const sessionId = recording.sessionId
      if (!sessionId || settledSessions.current.has(sessionId)) return

      const session = await getTeachSession(sessionId)

      if (
        session.status === 'awaiting_upload' &&
        recording.state === 'uploading' &&
        !isTeachUploadActive(sessionId)
      ) {
        await uploadTeachRecording(sessionId, recording)
        return
      }

      if (
        session.status === 'evidence_ready' ||
        session.status === 'agent_processing'
      ) {
        const thread = await ensureDivoTeachConversation(session)
        if (!announcedSessions.current.has(sessionId)) {
          announcedSessions.current.add(sessionId)
          toast.success('Teaching evidence is ready', {
            description: `${thread.title ?? 'Teach conversation'} is saved in Chats. Open it to review, clarify, and apply the learning.`,
          })
        }
        return
      }

      if (
        session.status === 'completed' ||
        session.status === 'persona_updated' ||
        session.status === 'no_learning'
      ) {
        await finalizeLocalTeachRecording(recording.path, sessionId)
        settledSessions.current.add(sessionId)
        return
      }

      if (session.status === 'failed' || session.status === 'cancelled') {
        settledSessions.current.add(sessionId)
      }
    }

    const reconcile = async () => {
      try {
        const recordings = await listLocalTeachRecordings()
        for (const recording of recordings) {
          if (!active) return
          try {
            await reconcileRecording(recording)
          } catch (error) {
            // Local media and sidecar state remain intact. The next pass can
            // retry transient status/storage errors without inventing success.
            console.warn('Teach background reconciliation failed', {
              sessionId: recording.sessionId,
              error,
            })
          }
        }
      } catch (error) {
        console.warn('Teach background recording inventory unavailable', error)
      } finally {
        if (active) {
          timer = window.setTimeout(() => void reconcile(), RECONCILE_INTERVAL_MS)
        }
      }
    }

    void reconcile()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  return null
}
