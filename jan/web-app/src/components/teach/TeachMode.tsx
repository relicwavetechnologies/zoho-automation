import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TeachSessionProgress } from './TeachSessionProgress'
import { TeachStudio, type TeachAccessProblem } from './TeachStudio'
import { TeachRecording } from './TeachRecording'
import { TeachHowItWorks } from './TeachHowItWorks'
import { TeachErrorPanel, type TeachErrorKind } from './TeachErrorPanel'
import { route } from '@/constants/routes'
import { ensureDivoTeachConversation } from '@/lib/divo-teach-thread'
import {
  useTeachActivity,
  useTeachWorkItems,
} from '@/hooks/useTeachActivity'
import {
  isTeachSessionWaitingForYou,
  isTransientTeachError,
  type TeachWorkItem,
} from '@/lib/teach-activity'
import {
  cancelTeachRecording,
  cancelTeachSession,
  createTeachSession,
  deleteLocalTeachRecording,
  getDivoSessionStatus,
  getTeachSession,
  getManagerPersonaTree,
  listRecentTeachLearnings,
  pickTeachRecording,
  recordTeachScreen,
  resumeTeachSession,
  stopTeachRecording,
  undoManagerPersona,
  uploadTeachRecording,
  type TeachRecordingFile,
  type TeachSession,
  type ManagerPersonaTree,
} from '@/lib/divo-teach'

/**
 * The Teach screen.
 *
 * Everything durable — the native recorder, local recordings, session status,
 * automatic retries — lives in the app-level Teach store and keeps running
 * whether or not this component is mounted. What is left here is genuinely
 * screen-local: which dialog is open, which failure the manager is looking at,
 * and whether they are actively waiting on a session they just started.
 *
 * That split is the point. Teach is a mode toggle on the home route, so this
 * component dies the moment the manager clicks anything else; when it comes
 * back it re-derives what is happening from the store rather than assuming
 * nothing was going on.
 */
export function TeachMode() {
  const router = useRouter()
  const [departmentId, setDepartmentId] = useState<string>()
  const [checkingAccess, setCheckingAccess] = useState(true)
  const [accessProblem, setAccessProblem] = useState<TeachAccessProblem>()
  const [errorKind, setErrorKind] = useState<TeachErrorKind>()
  /** Set when a send failed in a way the reconciler will recover by itself. */
  const [sendNotice, setSendNotice] = useState<string>()
  const [resuming, setResuming] = useState(false)
  /** The session this screen is actively waiting on, if any. */
  const [watchedSessionId, setWatchedSessionId] = useState<string>()
  const [watchedIsUploading, setWatchedIsUploading] = useState(false)
  const [activeRecording, setActiveRecording] = useState<TeachRecordingFile>()
  const [recentLearnings, setRecentLearnings] = useState<TeachSession[]>([])
  const [personaTree, setPersonaTree] = useState<ManagerPersonaTree | null>(null)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [overviewWarning, setOverviewWarning] = useState<string>()
  const [recordingToDelete, setRecordingToDelete] = useState<TeachWorkItem>()
  const [deletingRecording, setDeletingRecording] = useState(false)
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)
  const [undoTarget, setUndoTarget] = useState<TeachSession>()
  const [undoing, setUndoing] = useState(false)

  const recorder = useTeachActivity((state) => state.recorder)
  const online = useTeachActivity((state) => state.online)
  const sessions = useTeachActivity((state) => state.sessions)
  const uploadPercent = useTeachActivity((state) => state.uploadPercent)
  const forgetRecording = useTeachActivity((state) => state.forgetRecording)
  const workItems = useTeachWorkItems()

  const handoffSessionId = useRef<string | undefined>(undefined)
  const routeActiveRef = useRef(true)

  useEffect(() => () => {
    routeActiveRef.current = false
  }, [])

  const openTeachConversation = useCallback(
    async (current: TeachSession) => {
      if (handoffSessionId.current === current.id) return
      handoffSessionId.current = current.id

      try {
        const newThread = await ensureDivoTeachConversation(current)
        if (!routeActiveRef.current) return
        await router.navigate({
          to: route.threadsDetail,
          params: { threadId: newThread.id },
        })
      } catch (error) {
        handoffSessionId.current = undefined
        console.warn('Teach conversation handoff failed', error)
        setErrorKind('generic')
      }
    },
    [router]
  )

  useEffect(() => {
    let active = true
    void getDivoSessionStatus()
      .then((status) => {
        if (!active) return
        setDepartmentId(status.configured ? status.departmentId : undefined)
        // A failed check and a real "you do not manage this department" used
        // to produce the same message, which sent people hunting through
        // department settings for what was actually a dropped connection.
        setAccessProblem(status.configured ? undefined : 'not-manager')
      })
      .catch((error) => {
        console.warn('Teach session status unavailable', error)
        if (active) setAccessProblem('unreachable')
      })
      .finally(() => {
        if (active) setCheckingAccess(false)
      })
    return () => {
      active = false
    }
  }, [])

  const refreshOverview = useCallback(async () => {
    if (!departmentId) return
    setLoadingOverview(true)
    setOverviewWarning(undefined)
    try {
      const [learnings, tree] = await Promise.all([
        listRecentTeachLearnings(departmentId, 6),
        getManagerPersonaTree(departmentId),
      ])
      setRecentLearnings(learnings)
      setPersonaTree(tree)
    } catch (error) {
      console.warn('Teach recent learnings unavailable', error)
      setOverviewWarning(
        'Divo could not load your past sessions right now. Nothing has been lost.'
      )
    } finally {
      setLoadingOverview(false)
    }
  }, [departmentId])

  useEffect(() => {
    if (departmentId) void refreshOverview()
  }, [departmentId, refreshOverview])

  const watchedSession = watchedSessionId ? sessions[watchedSessionId] : undefined

  // Losing the connection while waiting is not a failure and must not be shown
  // as one — the recording and the session both still exist. Derived rather
  // than stored, because as state it was cleared again by every unrelated
  // re-render of the effect below.
  // The retry notice is scoped to a session that still has not been sent, so
  // it clears itself the moment the reconciler gets the video through.
  const statusWarning = !watchedSessionId
    ? undefined
    : !online
      ? 'Divo cannot be reached right now. Your recording is safe and this will pick up again automatically.'
      : watchedSession?.status === 'awaiting_upload'
        ? sendNotice
        : undefined

  // The background engine owns polling; this only reacts to what it publishes.
  useEffect(() => {
    if (!watchedSession) return

    if (isTeachSessionWaitingForYou(watchedSession)) {
      setWatchedSessionId(undefined)
      void openTeachConversation(watchedSession)
      return
    }
    if (
      watchedSession.status === 'completed' ||
      watchedSession.status === 'persona_updated' ||
      watchedSession.status === 'no_learning'
    ) {
      setWatchedSessionId(undefined)
      void openTeachConversation(watchedSession)
      void refreshOverview()
      return
    }
    if (watchedSession.status === 'failed') {
      setWatchedSessionId(undefined)
      setErrorKind('processing')
      return
    }
    if (watchedSession.status === 'cancelled') {
      setWatchedSessionId(undefined)
    }
  }, [openTeachConversation, refreshOverview, watchedSession])

  const reset = useCallback(() => {
    setErrorKind(undefined)
    setSendNotice(undefined)
    setWatchedSessionId(undefined)
    setWatchedIsUploading(false)
    setActiveRecording(undefined)
    handoffSessionId.current = undefined
  }, [])

  const ingest = useCallback(
    async (recording: TeachRecordingFile, source: 'recording' | 'upload') => {
      if (!departmentId) {
        setErrorKind('manager')
        return
      }

      let created: TeachSession | undefined
      try {
        setActiveRecording(recording)
        setErrorKind(undefined)
        setSendNotice(undefined)
        setWatchedIsUploading(true)
        created = await createTeachSession(departmentId, source, recording)
        setWatchedSessionId(created.id)
        useTeachActivity.getState().mergeSession(created)
        const queued = await uploadTeachRecording(created.id, recording)
        useTeachActivity.getState().mergeSession(queued)
        setWatchedIsUploading(false)
      } catch (error) {
        console.warn('Teach recording ingestion failed', error)
        setWatchedIsUploading(false)

        // A dropped connection is not a failed teaching. Divo holds a local
        // copy and the background reconciler is already retrying it, so
        // dead-ending into an error screen here would report a failure while
        // the recovery was underway — and strand the manager on a screen with
        // nothing to do but go back.
        if (created && recording.localOwned && isTransientTeachError(error)) {
          setSendNotice(
            'Divo could not be reached. Your recording is safe, and Divo keeps trying on its own.'
          )
          return
        }

        // The session is only cancelled when nothing was uploaded against it.
        // Cancelling one that already holds the video would throw away work
        // the backend has, purely because this screen saw an error.
        if (created && !recording.localOwned) {
          void cancelTeachSession(created.id).catch(() => undefined)
        }
        setWatchedSessionId(undefined)
        setErrorKind(
          String(error).includes('active department manager') ? 'manager' : 'upload'
        )
      }
    },
    [departmentId]
  )

  /** Send a recording that is sitting on this Mac, new session or not. */
  const sendWorkItem = useCallback(
    async (item: TeachWorkItem) => {
      const recording: TeachRecordingFile = {
        path: item.path,
        fileName: item.fileName,
        mimeType: 'video/quicktime',
        size: item.size,
        localOwned: true,
      }

      // An existing session that never received its video is resumed rather
      // than replaced, so the manager does not accumulate dead sessions.
      if (item.sessionId) {
        try {
          const existing = await getTeachSession(item.sessionId)
          if (existing.status === 'awaiting_upload') {
            setActiveRecording(recording)
            setWatchedSessionId(existing.id)
            setWatchedIsUploading(true)
            const queued = await uploadTeachRecording(existing.id, recording)
            useTeachActivity.getState().mergeSession(queued)
            setWatchedIsUploading(false)
            return
          }
        } catch (error) {
          console.warn('Teach session resume check failed', error)
          setWatchedIsUploading(false)
          setActiveRecording(recording)
          setErrorKind('upload')
          return
        }
      }

      await ingest(recording, 'recording')
    },
    [ingest]
  )

  const resumeSession = useCallback(async (sessionId: string) => {
    try {
      setResuming(true)
      const resumed = await resumeTeachSession(sessionId)
      useTeachActivity.getState().mergeSession(resumed)
    } catch (error) {
      console.warn('Teach session resume failed', error)
      setOverviewWarning(
        'Divo could not restart that just now. Your recording is safe — try again in a moment.'
      )
    } finally {
      setResuming(false)
    }
  }, [])

  const openWorkItem = useCallback(
    async (item: TeachWorkItem) => {
      if (!item.sessionId) return
      const current = sessions[item.sessionId] ?? (await getTeachSession(item.sessionId))
      handoffSessionId.current = undefined
      await openTeachConversation(current)
    },
    [openTeachConversation, sessions]
  )

  const deleteLocalRecording = useCallback(async () => {
    if (!recordingToDelete) return
    try {
      setDeletingRecording(true)
      await deleteLocalTeachRecording(recordingToDelete.path)
      forgetRecording(recordingToDelete.path)
      setRecordingToDelete(undefined)
    } catch (error) {
      console.warn('Teach local recording delete failed', error)
      setOverviewWarning('That recording could not be deleted. It is still here.')
    } finally {
      setDeletingRecording(false)
    }
  }, [forgetRecording, recordingToDelete])

  const startRecording = useCallback(async () => {
    try {
      setErrorKind(undefined)
      // Resolves when the recorder stops. The store's recorder status is what
      // drives the recording screen, so this can safely outlive the mount.
      const recording = await recordTeachScreen()
      await ingest(recording, 'recording')
    } catch (error) {
      if (String(error).includes('cancelled')) {
        reset()
        return
      }
      console.warn('Teach screen recording failed', error)
      setErrorKind('recorder')
    }
  }, [ingest, reset])

  const chooseRecording = useCallback(async () => {
    try {
      const recording = await pickTeachRecording()
      if (recording) await ingest(recording, 'upload')
    } catch (error) {
      console.warn('Teach recording selection failed', error)
      setErrorKind('upload')
    }
  }, [ingest])

  const cancelSession = useCallback(async () => {
    if (watchedSession?.canCancel) {
      await cancelTeachSession(watchedSession.id).catch(() => undefined)
    }
    reset()
  }, [reset, watchedSession])

  const undoLastLearning = useCallback(async () => {
    if (!departmentId) return
    try {
      setUndoing(true)
      await undoManagerPersona(departmentId)
      setUndoTarget(undefined)
      await refreshOverview()
    } catch (error) {
      console.warn('Teach persona undo failed', error)
      setOverviewWarning(
        'That could not be undone, so nothing was changed. Try again in a moment.'
      )
      setUndoTarget(undefined)
    } finally {
      setUndoing(false)
    }
  }, [departmentId, refreshOverview])

  // The recorder is the truth about recording, not this component's state.
  // Coming back to Teach mid-recording now shows the recording, instead of an
  // idle launcher whose button failed with "a recording is already open".
  if (recorder.recording) {
    return (
      <TeachRecording
        startedAt={recorder.startedAt}
        onStop={() => void stopTeachRecording()}
        onCancel={() => void cancelTeachRecording()}
      />
    )
  }

  if (errorKind) {
    return (
      <TeachErrorPanel
        kind={errorKind}
        lastError={watchedSession?.lastError}
        recording={activeRecording}
        onRetry={
          errorKind === 'recorder'
            ? () => void startRecording()
            : errorKind === 'upload' && activeRecording
              ? () => void ingest(activeRecording, 'recording')
              : undefined
        }
        onBack={reset}
      />
    )
  }

  if (watchedSessionId && (watchedIsUploading || watchedSession)) {
    // The same stall signal the recording list uses, so a session cannot look
    // wedged in one place and healthy in the other.
    const watchedItem = workItems.find(
      (item) => item.sessionId === watchedSessionId
    )
    return (
      <TeachSessionProgress
        session={watchedSession}
        uploading={watchedIsUploading}
        uploadProgress={uploadPercent[watchedSessionId] ?? 0}
        statusWarning={statusWarning}
        stuck={watchedItem?.canResume ?? false}
        resuming={resuming}
        onResume={() => void resumeSession(watchedSessionId)}
        onClose={() => {
          setWatchedSessionId(undefined)
          setWatchedIsUploading(false)
        }}
        onCancel={watchedSession?.canCancel ? () => void cancelSession() : undefined}
      />
    )
  }

  return (
    <>
      <TeachStudio
        checkingAccess={checkingAccess}
        accessProblem={accessProblem}
        departmentId={departmentId}
        online={online}
        loadingOverview={loadingOverview}
        overviewWarning={overviewWarning}
        workItems={workItems}
        recentLearnings={recentLearnings}
        personaTree={personaTree}
        undoing={undoing}
        onRecord={() => void startRecording()}
        onUpload={() => void chooseRecording()}
        onHowItWorks={() => setHowItWorksOpen(true)}
        onSendRecording={(item) => void sendWorkItem(item)}
        onOpenRecording={(item) => void openWorkItem(item)}
        onResumeRecording={(item) => {
          if (item.sessionId) void resumeSession(item.sessionId)
        }}
        onDeleteRecording={setRecordingToDelete}
        onUndoLastLearning={setUndoTarget}
      />

      <TeachHowItWorks
        open={howItWorksOpen}
        onOpenChange={setHowItWorksOpen}
        canRecord={!checkingAccess && Boolean(departmentId)}
        onRecord={() => void startRecording()}
      />

      <Dialog
        open={Boolean(recordingToDelete)}
        onOpenChange={(open) =>
          !open && !deletingRecording && setRecordingToDelete(undefined)
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogContentBody
            fileName={recordingToDelete?.fileName}
            deleting={deletingRecording}
            onCancel={() => setRecordingToDelete(undefined)}
            onConfirm={() => void deleteLocalRecording()}
          />
        </DialogContent>
      </Dialog>

      {/* Undo reverts the whole department persona to its previous revision,
          so the dialog names that rather than implying a per-row rollback. */}
      <Dialog
        open={Boolean(undoTarget)}
        onOpenChange={(open) => !open && !undoing && setUndoTarget(undefined)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Undo what Divo learned here?</DialogTitle>
            <DialogDescription>
              Divo goes back to how it worked before this session. Anything it
              learned from this recording is removed. The recording itself is
              not deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={undoing}
              onClick={() => setUndoTarget(undefined)}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={undoing}
              onClick={() => void undoLastLearning()}
            >
              {undoing ? 'Undoing…' : 'Undo this session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DialogContentBody({
  fileName,
  deleting,
  onCancel,
  onConfirm,
}: {
  fileName?: string
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete this recording?</DialogTitle>
        <DialogDescription>
          {fileName} is removed from this Mac for good, and Divo will never
          learn anything from it. This cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" disabled={deleting} onClick={onCancel}>
          Keep it
        </Button>
        <Button variant="destructive" disabled={deleting} onClick={onConfirm}>
          <Trash2 /> {deleting ? 'Deleting…' : 'Delete recording'}
        </Button>
      </DialogFooter>
    </>
  )
}
