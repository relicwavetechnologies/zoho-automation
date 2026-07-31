import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { ensureDivoTeachConversation } from '@/lib/divo-teach-thread'
import { useTeachActivity } from '@/hooks/useTeachActivity'
import {
  summarizeTeachActivity,
  teachReconnectDelayMs,
  teachRetryDelayMs,
} from '@/lib/teach-activity'
import {
  finalizeLocalTeachRecording,
  getTeachRecorderStatus,
  getTeachSession,
  isTeachUploadActive,
  listLocalTeachRecordings,
  uploadTeachRecording,
  type TeachLocalRecording,
  type TeachSession,
} from '@/lib/divo-teach'

/** Fast enough to feel live while something is happening. */
const ACTIVE_INTERVAL_MS = 1_500
/** Slow enough to be free when the manager is doing something else. */
const IDLE_INTERVAL_MS = 6_000

type UploadProgressEvent = {
  sessionId: string
  uploadedBytes: number
  totalBytes: number
  percent: number
}

function isMainWindow() {
  try {
    return getCurrentWebviewWindow().label === 'main'
  } catch {
    return true
  }
}

/**
 * The one place Teach work is kept alive.
 *
 * Everything about Teach outlives the screen that started it: the recorder is
 * a native process, the upload streams from Rust, and evidence is compiled on
 * the server. The Teach screen itself is a mode toggle on the home route, so
 * it unmounts the instant the manager clicks anything else. Previously that
 * unmount took the polling, the progress listener, and the retry logic with
 * it — the work carried on invisibly and the manager had no way to tell.
 *
 * This runs for the life of the app instead. It reads native sidecars and
 * server status, publishes both into the shared store that the Teach screen
 * and the background indicator render from, and quietly repairs what it can:
 * an upload interrupted by a webview refresh, a send that failed on bad wifi,
 * a finished session whose local copy is still waiting to be cleaned up.
 *
 * Its one hard rule is that it never invents success. Local media and sidecar
 * state are only discarded once the server confirms the learning landed.
 */
export function TeachReliabilityProvider() {
  const announcedSessions = useRef(new Set<string>())
  const settledSessions = useRef(new Set<string>())
  /** path -> { attempts, nextAttemptAt } for automatic upload retries. */
  const retries = useRef(new Map<string, { attempts: number; nextAt: number }>())
  /** Consecutive passes where the backend did not answer. */
  const unreachablePasses = useRef(0)

  useEffect(() => {
    if (!IS_TAURI || !isMainWindow()) return

    let active = true
    let timer: number | undefined
    let unlisten: UnlistenFn | undefined
    const store = useTeachActivity.getState

    void listen<UploadProgressEvent>('divo-teach-upload-progress', (event) => {
      store().setUploadPercent(event.payload.sessionId, event.payload.percent)
    }).then((dispose) => {
      // The effect may have torn down while the listener was registering.
      if (active) unlisten = dispose
      else dispose()
    })

    /**
     * Restart an upload that stopped without the server receiving the video.
     *
     * Gated on Rust's own view of what is streaming rather than any
     * JavaScript flag, because the whole point is to survive a webview reload
     * that wipes JavaScript state while the native upload keeps running.
     */
    const resumeUpload = async (
      recording: TeachLocalRecording,
      sessionId: string
    ) => {
      if (await isTeachUploadActive(sessionId)) return

      const retry = retries.current.get(recording.path)
      if (retry && Date.now() < retry.nextAt) return

      const attempts = (retry?.attempts ?? 0) + 1
      retries.current.set(recording.path, {
        attempts,
        nextAt: Date.now() + teachRetryDelayMs(attempts),
      })
      await uploadTeachRecording(sessionId, recording)
      // Succeeded, so a later unrelated failure starts from a short delay.
      retries.current.delete(recording.path)
    }

    const reconcileRecording = async (
      recording: TeachLocalRecording,
      onUnreachable: () => void
    ) => {
      const sessionId = recording.sessionId
      if (!sessionId || settledSessions.current.has(sessionId)) return

      let session: TeachSession
      try {
        session = await getTeachSession(sessionId)
      } catch (error) {
        // A failed status read is the one signal that genuinely means "Divo
        // cannot be reached". An upload rejected for its own reasons, or a
        // thread that failed to save, must not be presented as being offline.
        onUnreachable()
        throw error
      }
      store().mergeSession(session)

      if (session.status === 'awaiting_upload') {
        await resumeUpload(recording, sessionId)
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
        store().forgetRecording(recording.path)
        return
      }

      if (session.status === 'failed' || session.status === 'cancelled') {
        settledSessions.current.add(sessionId)
      }
    }

    const reconcile = async () => {
      let reachable = true
      let busy = false

      try {
        store().setRecorder(await getTeachRecorderStatus())
      } catch (error) {
        // A recorder-status failure says nothing about the backend, so it must
        // not flip the app into its offline presentation.
        console.warn('Teach recorder status unavailable', error)
      }

      let recordings: TeachLocalRecording[] = []
      try {
        recordings = await listLocalTeachRecordings()
        store().setRecordings(recordings)
      } catch (error) {
        console.warn('Teach background recording inventory unavailable', error)
      }

      const sessionIds = recordings
        .map((recording) => recording.sessionId)
        .filter((id): id is string => Boolean(id))

      try {
        const streaming = await Promise.all(
          sessionIds.map(async (id) =>
            (await isTeachUploadActive(id)) ? id : null
          )
        )
        store().setUploading(streaming.filter((id): id is string => Boolean(id)))
      } catch (error) {
        console.warn('Teach upload state unavailable', error)
      }

      for (const recording of recordings) {
        if (!active) return
        try {
          await reconcileRecording(recording, () => {
            reachable = false
          })
        } catch (error) {
          // Local media and sidecar state remain intact. The next pass can
          // retry transient status/storage errors without inventing success.
          console.warn('Teach background reconciliation failed', {
            sessionId: recording.sessionId,
            error,
          })
        }
      }

      const state = store()
      const recovered = reachable && unreachablePasses.current > 0
      unreachablePasses.current = reachable ? 0 : unreachablePasses.current + 1
      if (recovered) {
        // The backend answered again. Anything holding a long retry delay
        // should go now, not sit out a two-minute backoff that was only ever
        // waiting for the connection this pass just proved is back.
        retries.current.clear()
      }
      state.setOnline(reachable)
      state.markReconciled()
      // Poll fast only while something is genuinely moving. A recording that
      // is merely sitting on disk waiting to be sent is not a reason to keep
      // the app busy in the background.
      const summary = summarizeTeachActivity({
        recorder: state.recorder,
        recordings: state.recordings,
        sessions: state.sessions,
        uploading: state.uploading,
        uploadPercent: state.uploadPercent,
        progressSeenAt: state.progressSeenAt,
        now: Date.now(),
        online: reachable,
      })
      busy =
        summary !== null &&
        ['recording', 'sending', 'thinking'].includes(summary.phase)

      if (active) {
        // Probing quickly at first means a backend that was restarted is
        // picked up in a couple of seconds; backing off after that means a
        // genuinely dead one is not hammered every second and a half.
        const delay = !reachable
          ? teachReconnectDelayMs(unreachablePasses.current - 1)
          : busy
            ? ACTIVE_INTERVAL_MS
            : IDLE_INTERVAL_MS
        timer = window.setTimeout(() => void reconcile(), delay)
      }
    }

    void reconcile()
    return () => {
      active = false
      unlisten?.()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  return null
}
