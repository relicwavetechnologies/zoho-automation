import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  ArrowLeft,
  CircleStop,
  Database,
  FileVideo2,
  HardDrive,
  Mic,
  MonitorUp,
  ShieldCheck,
  Sparkles,
  RotateCcw,
  Trash2,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { TeachProcessingExperience, TeachResultExperience } from './TeachExperience'
import {
  cancelTeachRecording,
  cancelTeachSession,
  createTeachSession,
  deleteLocalTeachRecording,
  finalizeLocalTeachRecording,
  getDivoSessionStatus,
  getTeachSession,
  listLocalTeachRecordings,
  listRecentTeachLearnings,
  pickTeachRecording,
  recordTeachScreen,
  refineTeachSession,
  uploadTeachRecording,
  undoManagerPersona,
  type TeachRecordingFile,
  type TeachLocalRecording,
  type TeachSession,
} from '@/lib/divo-teach'

type TeachStage = 'intro' | 'recording' | 'uploading' | 'processing' | 'ready' | 'error'
type TeachErrorKind = 'manager' | 'recorder' | 'upload' | 'processing' | 'generic'

type UploadProgress = {
  sessionId: string
  uploadedBytes: number
  totalBytes: number
  percent: number
}

const describeProcessingFailure = (lastError: string | null | undefined) => {
  if (lastError?.includes('Failed to process successful response')) {
    return "The recording was processed, but Divo could not validate the persona model's response. No persona changes were saved."
  }
  if (lastError?.includes('Transaction not found') || lastError?.includes("Can't reach database server")) {
    return 'The recording was processed, but Divo lost its database connection while saving the persona. No persona changes were saved.'
  }
  return 'The recording was processed, but Divo could not update your persona. No persona changes were saved.'
}

const formatBytes = (bytes: number | null) => {
  if (!bytes) return 'Unknown size'
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

const formatLearningDate = (value: string) => new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}).format(new Date(value))

export function TeachMode() {
  const [stage, setStage] = useState<TeachStage>('intro')
  const [departmentId, setDepartmentId] = useState<string>()
  const [checkingAccess, setCheckingAccess] = useState(true)
  const [session, setSession] = useState<TeachSession>()
  const [uploadProgress, setUploadProgress] = useState(0)
  const [errorKind, setErrorKind] = useState<TeachErrorKind>('generic')
  const [statusWarning, setStatusWarning] = useState<string>()
  const [undoing, setUndoing] = useState(false)
  const [undoMessage, setUndoMessage] = useState<string>()
  const [activeRecording, setActiveRecording] = useState<TeachRecordingFile>()
  const [localRecordings, setLocalRecordings] = useState<TeachLocalRecording[]>([])
  const [recentLearnings, setRecentLearnings] = useState<TeachSession[]>([])
  const [loadingOverview, setLoadingOverview] = useState(false)
  const [overviewWarning, setOverviewWarning] = useState<string>()
  const [recordingToDelete, setRecordingToDelete] = useState<TeachLocalRecording>()
  const [deletingRecording, setDeletingRecording] = useState(false)
  const sessionId = session?.id
  const sessionStatus = session?.status

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
          if (current.status === 'persona_updated' || current.status === 'no_learning') {
            await finalizeLocalTeachRecording(recording.path, recording.sessionId)
            return null
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
      setRecentLearnings(await listRecentTeachLearnings(departmentId, 6))
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

  useEffect(() => () => {
    // Leaving Teach must never leave the macOS recorder running invisibly.
    void cancelTeachRecording().catch(() => undefined)
  }, [])

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
        if (current.status === 'persona_updated' || current.status === 'no_learning') {
          setStage('ready')
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
  }, [activeRecording, sessionId, sessionStatus])

  const reset = useCallback(() => {
    setStage('intro')
    setSession(undefined)
    setUploadProgress(0)
    setErrorKind('generic')
    setStatusWarning(undefined)
    setUndoing(false)
    setUndoMessage(undefined)
    setActiveRecording(undefined)
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

  const undo = useCallback(async () => {
    if (!departmentId || !session || session.remainingUndos < 1) return
    try {
      setUndoing(true)
      const result = await undoManagerPersona(departmentId)
      setSession(current => current ? { ...current, remainingUndos: result.remainingUndos } : current)
      setUndoMessage('Persona change undone.')
    } catch (error) {
      console.warn('Teach persona Undo failed', error)
      setUndoMessage('Undo could not be completed. Please try again.')
    } finally {
      setUndoing(false)
    }
  }, [departmentId, session])

  const refine = useCallback(async (correction: string) => {
    if (!session) throw new Error('Teach result is unavailable')
    const refinement = await refineTeachSession(session.id, correction)
    setSession(refinement)
    setStatusWarning(undefined)
    setUndoMessage(undefined)
    setStage('processing')
  }, [session])

  if (stage === 'intro') {
    return (
      <div className="h-full overflow-y-auto px-5 py-8 sm:px-8" data-testid="teach-mode">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col py-6">
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_0.85fr]">
            <div>
              <Badge variant="outline" className="mb-5 border-violet-500/25 bg-violet-500/5 text-violet-500">
                <Sparkles className="size-3" /> Manager teaching
              </Badge>
              <h1 className="max-w-xl font-studio text-3xl font-medium tracking-tight sm:text-4xl">
                Teach Divo how you want work done.
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
                Record your main screen while you work and explain your decisions. Divo will use the demonstration to grow your department persona.
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <Button
                  size="lg"
                  onClick={() => void startRecording()}
                  disabled={checkingAccess || !departmentId}
                  data-testid="start-teach-recording"
                >
                  <Video /> Record teaching
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => void chooseRecording()}
                  disabled={checkingAccess || !departmentId}
                  data-testid="upload-teach-recording"
                >
                  <Upload /> Upload recording
                </Button>
              </div>
              {!checkingAccess && !departmentId && (
                <p className="mt-3 text-sm text-amber-600">
                  Select a department you manage before starting Teach.
                </p>
              )}

              <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
                <Signal icon={MonitorUp} label="Your main display" />
                <Signal icon={Mic} label="Your explanation" />
                <Signal icon={ShieldCheck} label="Two Undos saved" />
              </div>
            </div>

            <div className="rounded-2xl border bg-card p-6 shadow-sm">
              <div className="grid size-11 place-items-center rounded-xl bg-violet-500/10 text-violet-500">
                <FileVideo2 className="size-5" />
              </div>
              <h2 className="mt-5 font-studio text-xl font-medium">A normal Mac recording</h2>
              <div className="mt-5 space-y-4">
                <Step number="1" text="Your main display starts recording." />
                <Step number="2" text="Work normally and explain what matters." />
                <Step number="3" text="Stop from the Mac menu bar when finished." />
              </div>
              <p className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
                Nothing is recorded in the background. Teach runs only when you start a session.
              </p>
            </div>
          </div>

          <div className="mt-10 grid gap-5 border-t pt-8 lg:grid-cols-2">
            <section className="rounded-xl border bg-card">
              <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                <div className="flex items-center gap-2">
                  <HardDrive className="size-4 text-muted-foreground" />
                  <div>
                    <h2 className="text-sm font-medium">Local recording retry inbox</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">Kept on this Mac until processing succeeds</p>
                  </div>
                </div>
                <Badge variant="outline">{localRecordings.length}</Badge>
              </div>
              <div className="divide-y">
                {localRecordings.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-muted-foreground">
                    {loadingOverview ? 'Checking local recordings…' : 'No recordings are waiting for processing.'}
                  </p>
                ) : localRecordings.slice(0, 4).map(recording => {
                  const canRetry = recording.state === 'ready' || recording.state === 'retryable'
                  return (
                    <div key={recording.path} className="flex items-center gap-3 px-5 py-4">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <FileVideo2 className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{recording.fileName}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{formatBytes(recording.size)} · {recording.state.replaceAll('_', ' ')}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canRetry}
                          onClick={() => void retryLocalRecording(recording)}
                        >
                          <RotateCcw /> {canRetry ? 'Retry' : 'Processing'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          aria-label={`Delete ${recording.fileName}`}
                          onClick={() => setRecordingToDelete(recording)}
                        >
                          <Trash2 /> Delete
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="rounded-xl border bg-card">
              <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
                <div className="flex items-center gap-2">
                  <Database className="size-4 text-muted-foreground" />
                  <div>
                    <h2 className="text-sm font-medium">Recent persona learnings</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">Read directly from the Teach database</p>
                  </div>
                </div>
                <Badge variant="outline">From DB</Badge>
              </div>
              <div className="divide-y">
                {recentLearnings.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-muted-foreground">
                    {loadingOverview ? 'Loading recent learnings…' : 'No completed persona learnings yet.'}
                  </p>
                ) : recentLearnings.slice(0, 4).map(learning => (
                  <div key={learning.id} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <Badge variant="secondary">{learning.appliedChangeCount} {learning.appliedChangeCount === 1 ? 'rule' : 'rules'}</Badge>
                      <span className="font-mono text-[10px] text-muted-foreground">{formatLearningDate(learning.updatedAt)}</span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm leading-5">{learning.understanding}</p>
                    {learning.appliedChanges[0]?.instruction && (
                      <p className="mt-2 line-clamp-2 border-l-2 border-emerald-500/30 pl-3 text-xs leading-5 text-muted-foreground">
                        {learning.appliedChanges[0].instruction}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
          {overviewWarning && <p className="mt-3 text-xs text-amber-600" role="status">{overviewWarning}</p>}
        </div>

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
      </div>
    )
  }

  if (stage === 'recording') {
    return (
      <CenteredCard>
        <PulsingIcon icon={Video} />
        <Badge variant="secondary" className="mt-5">Recording in progress</Badge>
        <h1 className="mt-4 font-studio text-2xl font-medium">Show Divo how you work</h1>
        <p className="mt-2 max-w-md text-center leading-6 text-muted-foreground">
          Your main display is recording. Work normally and explain your decisions, then stop from the Mac menu bar.
        </p>
        <Button variant="outline" className="mt-6" onClick={() => void cancel()}>
          <CircleStop /> Cancel recording
        </Button>
      </CenteredCard>
    )
  }

  if (stage === 'uploading') {
    return (
      <CenteredCard>
        <PulsingIcon icon={Upload} />
        <h1 className="mt-5 font-studio text-2xl font-medium">Uploading your teaching</h1>
        <p className="mt-2 max-w-md text-center text-sm leading-6 text-muted-foreground">
          The recording is streamed securely without loading the whole video into memory.
        </p>
        <div className="mt-6 w-full max-w-md">
          <Progress value={uploadProgress} />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>Uploading</span>
            <span>{uploadProgress}%</span>
          </div>
        </div>
        {session?.canCancel && (
          <Button variant="ghost" className="mt-5" onClick={() => void cancel()}>Cancel</Button>
        )}
      </CenteredCard>
    )
  }

  if (stage === 'processing' && session) {
    return (
      <TeachProcessingExperience
        session={session}
        statusWarning={statusWarning}
        onCancel={session.canCancel ? () => void cancel() : undefined}
      />
    )
  }

  if (stage === 'ready' && session) {
    return (
      <TeachResultExperience
        session={session}
        undoing={undoing}
        undoMessage={undoMessage}
        onUndo={() => void undo()}
        onRefine={refine}
        onFinish={reset}
      />
    )
  }

  const errorTitle = errorKind === 'manager'
    ? 'Manager access required'
    : errorKind === 'recorder'
      ? 'Screen recorder could not start'
      : errorKind === 'upload'
        ? 'Upload failed'
        : errorKind === 'processing'
          ? 'Persona update failed'
          : 'Teaching did not complete'
  const errorDescription = errorKind === 'manager'
    ? 'Teach currently learns only from the manager of the selected department.'
    : errorKind === 'recorder'
      ? 'Allow Screen & System Audio Recording and Microphone access for Divo in Mac System Settings, then try again.'
      : errorKind === 'upload'
        ? 'Your recording was completed and saved locally, but Divo could not upload it. Your persona was not changed.'
        : errorKind === 'processing'
          ? describeProcessingFailure(session?.lastError)
          : 'Divo could not complete this teaching workflow. Your persona was not changed.'

  return (
    <CenteredCard>
      <div className="grid size-12 place-items-center rounded-xl bg-amber-500/10 text-amber-600">
        <FileVideo2 className="size-5" />
      </div>
      <h1 className="mt-5 font-studio text-2xl font-medium">
        {errorTitle}
      </h1>
      <p className="mt-2 max-w-md text-center leading-6 text-muted-foreground">
        {errorDescription}
      </p>
      <Button className="mt-6" onClick={reset}>
        <ArrowLeft /> Try again
      </Button>
    </CenteredCard>
  )
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto px-5 py-8" data-testid="teach-mode">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center rounded-2xl border bg-card p-8 shadow-sm">
        {children}
      </div>
    </div>
  )
}

function PulsingIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="relative grid size-14 place-items-center rounded-2xl bg-violet-500/10 text-violet-500">
      <span className="absolute inset-0 animate-ping rounded-2xl bg-violet-500/10" />
      <Icon className="relative size-6" />
    </span>
  )
}

function Signal({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card/70 px-3 py-2.5 text-sm">
      <span className="grid size-7 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      {label}
    </div>
  )
}

function Step({ number, text }: { number: string; text: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground">
        {number}
      </span>
      <span className="pt-0.5 leading-5">{text}</span>
    </div>
  )
}
