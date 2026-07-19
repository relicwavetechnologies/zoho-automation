import { useCallback, useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
import { TeachStudio } from './TeachStudio'
import { TeachRecording } from './TeachRecording'
import { TeachHowItWorks } from './TeachHowItWorks'
import { TeachErrorPanel, type TeachErrorKind } from './TeachErrorPanel'
import { route } from '@/constants/routes'
import { ensureDivoTeachConversation } from '@/lib/divo-teach-thread'
import {
  cancelTeachRecording,
  cancelTeachSession,
  createTeachSession,
  deleteLocalTeachRecording,
  finalizeLocalTeachRecording,
  getDivoSessionStatus,
  getTeachSession,
  getManagerPersonaTree,
  listLocalTeachRecordings,
  listRecentTeachLearnings,
  pickTeachRecording,
  recordTeachScreen,
  undoManagerPersona,
  uploadTeachRecording,
  type TeachRecordingFile,
  type TeachLocalRecording,
  type TeachSession,
  type ManagerPersonaTree,
} from '@/lib/divo-teach'

type TeachStage = 'intro' | 'recording' | 'uploading' | 'processing' | 'error'

type UploadProgress = {
  sessionId: string
  uploadedBytes: number
  totalBytes: number
  percent: number
}

export function TeachMode() {
  const router = useRouter()
  const [stage, setStage] = useState<TeachStage>('intro')
  const [departmentId, setDepartmentId] = useState<string>()
  const [checkingAccess, setCheckingAccess] = useState(true)
  const [session, setSession] = useState<TeachSession>()
  const [uploadProgress, setUploadProgress] = useState(0)
  const [errorKind, setErrorKind] = useState<TeachErrorKind>('generic')
  const [statusWarning, setStatusWarning] = useState<string>()
  const [activeRecording, setActiveRecording] = useState<TeachRecordingFile>()
  const [localRecordings, setLocalRecordings] = useState<TeachLocalRecording[]>([])
  const [recentLearnings, setRecentLearnings] = useState<TeachSession[]>([])
  const [personaTree, setPersonaTree] = useState<ManagerPersonaTree | null>(null)
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [overviewWarning, setOverviewWarning] = useState<string>()
  const [recordingToDelete, setRecordingToDelete] = useState<TeachLocalRecording>()
  const [deletingRecording, setDeletingRecording] = useState(false)
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)
  const [undoTarget, setUndoTarget] = useState<TeachSession>()
  const [undoing, setUndoing] = useState(false)
  const sessionId = session?.id
  const sessionStatus = session?.status
  const handoffSessionId = useRef<string | undefined>(undefined)
  const routeActiveRef = useRef(true)

  useEffect(() => () => {
    routeActiveRef.current = false
  }, [])

  const openTeachConversation = useCallback(async (current: TeachSession) => {
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
      setStage('error')
    }
  }, [router])

  useEffect(() => {
    let active = true
    void getDivoSessionStatus()
      .then((status) => {
        if (active) setDepartmentId(status.configured ? status.departmentId : undefined)
      })
      .catch((error) => console.warn('Teach session status unavailable', error))
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
      const local = await listLocalTeachRecordings()
      const reconciled = await Promise.all(local.map(async recording => {
        if (!recording.sessionId || recording.state === 'ready' || recording.state === 'retryable') {
          return recording
        }
        try {
          const current = await getTeachSession(recording.sessionId)
          if (current.status === 'completed' || current.status === 'persona_updated' || current.status === 'no_learning') {
            await finalizeLocalTeachRecording(recording.path, recording.sessionId)
            return null
          }
          if (current.status === 'evidence_ready' || current.status === 'agent_processing') {
            return { ...recording, state: 'agent_ready' as const }
          }
          if (current.status === 'failed' || current.status === 'cancelled') {
            return { ...recording, state: 'retryable' as const, lastError: current.lastError }
          }
          return { ...recording, state: 'processing' as const }
        } catch {
          // Do not offer a duplicate retry while the server outcome is unknown.
          return recording
        }
      }))
      setLocalRecordings(reconciled.filter((recording): recording is TeachLocalRecording => recording !== null))
    } catch (error) {
      console.warn('Teach local recording inventory unavailable', error)
      setOverviewWarning('Local recording history could not be loaded.')
    }
    try {
      const [learnings, tree] = await Promise.all([
        listRecentTeachLearnings(departmentId, 6),
        getManagerPersonaTree(departmentId),
      ])
      setRecentLearnings(learnings)
      setPersonaTree(tree)
    } catch (error) {
      console.warn('Teach recent learnings unavailable', error)
      setOverviewWarning(current => current ?? 'Recent database learnings could not be loaded.')
    } finally {
      setLoadingOverview(false)
    }
  }, [departmentId])

  useEffect(() => {
    if (stage === 'intro' && departmentId) void refreshOverview()
  }, [departmentId, refreshOverview, stage])

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    void listen<UploadProgress>('divo-teach-upload-progress', (event) => {
      if (!sessionId || event.payload.sessionId === sessionId) {
        setUploadProgress(event.payload.percent)
      }
    }).then((dispose) => {
      unlisten = dispose
    })
    return () => unlisten?.()
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !sessionStatus || ![
      'queued',
      'ingesting',
      'evidence_ready',
      'agent_processing',
      'ready_for_processing',
      'persona_processing',
    ].includes(sessionStatus)) return
    let active = true
    let timer: number | undefined
    const refresh = async () => {
      try {
        const current = await getTeachSession(sessionId)
        if (!active) return
        setStatusWarning(undefined)
        setSession(current)
        if (current.status === 'evidence_ready' || current.status === 'agent_processing') {
          void openTeachConversation(current)
        }
        if (current.status === 'completed' || current.status === 'persona_updated' || current.status === 'no_learning') {
          void openTeachConversation(current)
          if (activeRecording?.localOwned) {
            void finalizeLocalTeachRecording(activeRecording.path, current.id)
              .then(() => {
                setActiveRecording(undefined)
                setLocalRecordings(recordings => recordings.filter(recording => recording.path !== activeRecording.path))
              })
              .catch(error => console.warn('Processed Teach recording local cleanup failed', error))
          }
        }
        if (current.status === 'failed') {
          setErrorKind('processing')
          setStage('error')
        }
        if (current.status === 'cancelled') setStage('error')
      } catch (error) {
        console.warn('Teach processing status unavailable', error)
        if (active) {
          setStatusWarning('Status temporarily unavailable. Divo has not reported success or failure yet.')
        }
      } finally {
        // Schedule only after the current request settles. A setInterval here
        // creates overlapping requests when the database is slow or offline.
        if (active) timer = window.setTimeout(() => void refresh(), 1_000)
      }
    }
    void refresh()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeRecording, openTeachConversation, sessionId, sessionStatus])

  const reset = useCallback(() => {
    setStage('intro')
    setSession(undefined)
    setUploadProgress(0)
    setErrorKind('generic')
    setStatusWarning(undefined)
    setActiveRecording(undefined)
    handoffSessionId.current = undefined
  }, [])

  const ingest = useCallback(async (
    recording: TeachRecordingFile,
    source: 'recording' | 'upload'
  ) => {
    if (!departmentId) {
      setErrorKind('manager')
      setStage('error')
      return
    }

    let created: TeachSession | undefined
    try {
      setActiveRecording(recording)
      setUploadProgress(0)
      setStage('uploading')
      created = await createTeachSession(departmentId, source, recording)
      setSession(created)
      const queued = await uploadTeachRecording(created.id, recording)
      setSession(queued)
      setUploadProgress(100)
      setStage('processing')
    } catch (error) {
      console.warn('Teach recording ingestion failed', error)
      if (created) void cancelTeachSession(created.id).catch(() => undefined)
      setErrorKind(String(error).includes('active department manager') ? 'manager' : 'upload')
      setStage('error')
    }
  }, [departmentId])

  const retryLocalRecording = useCallback(async (recording: TeachLocalRecording) => {
    await ingest(recording, 'recording')
  }, [ingest])

  const resumeLocalTeaching = useCallback(async (recording: TeachLocalRecording) => {
    if (!recording.sessionId) return
    const current = await getTeachSession(recording.sessionId)
    setActiveRecording(recording)
    setSession(current)
    await openTeachConversation(current)
  }, [openTeachConversation])

  const deleteLocalRecording = useCallback(async () => {
    if (!recordingToDelete) return
    try {
      setDeletingRecording(true)
      await deleteLocalTeachRecording(recordingToDelete.path)
      setLocalRecordings(recordings => recordings.filter(recording => recording.path !== recordingToDelete.path))
      setRecordingToDelete(undefined)
    } catch (error) {
      console.warn('Teach local recording delete failed', error)
      setOverviewWarning('The local recording could not be deleted.')
    } finally {
      setDeletingRecording(false)
    }
  }, [recordingToDelete])

  const startRecording = useCallback(async () => {
    try {
      setStage('recording')
      const recording = await recordTeachScreen()
      await ingest(recording, 'recording')
    } catch (error) {
      if (String(error).includes('cancelled')) {
        reset()
        return
      }
      console.warn('Teach screen recording failed', error)
      setErrorKind('recorder')
      setStage('error')
    }
  }, [ingest, reset])

  const chooseRecording = useCallback(async () => {
    try {
      const recording = await pickTeachRecording()
      if (recording) await ingest(recording, 'upload')
    } catch (error) {
      console.warn('Teach recording selection failed', error)
      setErrorKind('upload')
      setStage('error')
    }
  }, [ingest])

  const cancel = useCallback(async () => {
    if (stage === 'recording') await cancelTeachRecording().catch(() => undefined)
    if (session?.canCancel) await cancelTeachSession(session.id).catch(() => undefined)
    reset()
  }, [reset, session, stage])

  const undoLastLearning = useCallback(async () => {
    if (!departmentId) return
    try {
      setUndoing(true)
      await undoManagerPersona(departmentId)
      setUndoTarget(undefined)
      await refreshOverview()
    } catch (error) {
      console.warn('Teach persona undo failed', error)
      setOverviewWarning('That learning could not be undone. Your persona is unchanged.')
      setUndoTarget(undefined)
    } finally {
      setUndoing(false)
    }
  }, [departmentId, refreshOverview])

  if (stage === 'intro') {
    return (
      <>
        <TeachStudio
          checkingAccess={checkingAccess}
          departmentId={departmentId}
          loadingOverview={loadingOverview}
          overviewWarning={overviewWarning}
          localRecordings={localRecordings}
          recentLearnings={recentLearnings}
          personaTree={personaTree}
          undoing={undoing}
          onRecord={() => void startRecording()}
          onUpload={() => void chooseRecording()}
          onHowItWorks={() => setHowItWorksOpen(true)}
          onRetryRecording={recording => void retryLocalRecording(recording)}
          onResumeRecording={recording => void resumeLocalTeaching(recording)}
          onDeleteRecording={setRecordingToDelete}
          onUndoLastLearning={setUndoTarget}
        />

        <TeachHowItWorks
          open={howItWorksOpen}
          onOpenChange={setHowItWorksOpen}
          canRecord={!checkingAccess && Boolean(departmentId)}
          onRecord={() => void startRecording()}
        />

        <Dialog open={Boolean(recordingToDelete)} onOpenChange={open => !open && !deletingRecording && setRecordingToDelete(undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete local recording?</DialogTitle>
              <DialogDescription>
                {recordingToDelete?.fileName} will be permanently removed from this Mac. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={deletingRecording} onClick={() => setRecordingToDelete(undefined)}>Cancel</Button>
              <Button variant="destructive" disabled={deletingRecording} onClick={() => void deleteLocalRecording()}>
                <Trash2 /> {deletingRecording ? 'Deleting…' : 'Delete recording'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Undo reverts the whole department persona to its previous revision,
            so the dialog names that rather than implying a per-row rollback. */}
        <Dialog open={Boolean(undoTarget)} onOpenChange={open => !open && !undoing && setUndoTarget(undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Undo this learning?</DialogTitle>
              <DialogDescription>
                Your department persona rolls back to the revision before this
                session. Rules and skills it created are removed. The recording
                itself is not deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={undoing} onClick={() => setUndoTarget(undefined)}>Keep it</Button>
              <Button
                variant="destructive"
                disabled={undoing}
                onClick={() => void undoLastLearning()}
              >
                {undoing ? 'Undoing…' : 'Undo learning'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  if (stage === 'recording') {
    return <TeachRecording onCancel={() => void cancel()} />
  }

  if (stage === 'uploading' || (stage === 'processing' && session)) {
    return (
      <TeachSessionProgress
        session={session}
        uploading={stage === 'uploading'}
        uploadProgress={uploadProgress}
        statusWarning={statusWarning}
        onCancel={session?.canCancel ? () => void cancel() : undefined}
      />
    )
  }

  return (
    <TeachErrorPanel
      kind={errorKind}
      lastError={session?.lastError}
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
