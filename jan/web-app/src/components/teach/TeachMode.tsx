import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  ArrowLeft,
  CheckCircle2,
  CircleStop,
  FileVideo2,
  Mic,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Undo2,
  Upload,
  Video,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  cancelTeachRecording,
  cancelTeachSession,
  createTeachSession,
  getDivoSessionStatus,
  getTeachSession,
  pickTeachRecording,
  recordTeachScreen,
  uploadTeachRecording,
  undoManagerPersona,
  type TeachRecordingFile,
  type TeachSession,
} from '@/lib/divo-teach'

type TeachStage = 'intro' | 'recording' | 'uploading' | 'processing' | 'ready' | 'error'

type UploadProgress = {
  sessionId: string
  uploadedBytes: number
  totalBytes: number
  percent: number
}

const formatBytes = (bytes: number | null) => {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

export function TeachMode() {
  const [stage, setStage] = useState<TeachStage>('intro')
  const [departmentId, setDepartmentId] = useState<string>()
  const [checkingAccess, setCheckingAccess] = useState(true)
  const [session, setSession] = useState<TeachSession>()
  const [uploadProgress, setUploadProgress] = useState(0)
  const [errorKind, setErrorKind] = useState<'manager' | 'recorder' | 'generic'>('generic')
  const [undoing, setUndoing] = useState(false)
  const [undoMessage, setUndoMessage] = useState<string>()
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
    const refresh = async () => {
      try {
        const current = await getTeachSession(sessionId)
        if (!active) return
        setSession(current)
        if (current.status === 'persona_updated' || current.status === 'no_learning') setStage('ready')
        if (current.status === 'failed' || current.status === 'cancelled') setStage('error')
      } catch (error) {
        console.warn('Teach processing status unavailable', error)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [sessionId, sessionStatus])

  const reset = useCallback(() => {
    setStage('intro')
    setSession(undefined)
    setUploadProgress(0)
    setErrorKind('generic')
    setUndoing(false)
    setUndoMessage(undefined)
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
      setErrorKind(String(error).includes('active department manager') ? 'manager' : 'generic')
      setStage('error')
    }
  }, [departmentId])

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

  if (stage === 'intro') {
    return (
      <div className="h-full overflow-y-auto px-5 py-8 sm:px-8" data-testid="teach-mode">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center py-6">
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
        </div>
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

  if (stage === 'uploading' || stage === 'processing') {
    const progress = stage === 'uploading' ? uploadProgress : Math.max(25, session?.progress ?? 25)
    const applyingPersona = session?.status === 'persona_processing'
    return (
      <CenteredCard>
        <PulsingIcon icon={stage === 'uploading' ? Upload : RefreshCw} />
        <h1 className="mt-5 font-studio text-2xl font-medium">
          {stage === 'uploading'
            ? 'Uploading your teaching'
            : applyingPersona
              ? 'Growing your persona'
              : 'Understanding your workflow'}
        </h1>
        <p className="mt-2 max-w-md text-center text-sm leading-6 text-muted-foreground">
          {stage === 'uploading'
            ? 'The recording is streamed securely without loading the whole video into memory.'
            : applyingPersona
              ? 'Divo is checking the evidence and applying only high-confidence working rules.'
              : 'Divo is selecting useful screens, reading the interface and transcribing your explanation.'}
        </p>
        <div className="mt-6 w-full max-w-md">
          <Progress value={progress} />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{stage === 'uploading' ? 'Uploading' : session?.status.replaceAll('_', ' ')}</span>
            <span>{progress}%</span>
          </div>
        </div>
        {session?.canCancel && (
          <Button variant="ghost" className="mt-5" onClick={() => void cancel()}>Cancel</Button>
        )}
      </CenteredCard>
    )
  }

  if (stage === 'ready') {
    const learned = session?.status === 'persona_updated'
    return (
      <CenteredCard>
        <div className="grid size-14 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600">
          <CheckCircle2 className="size-7" />
        </div>
        <h1 className="mt-5 font-studio text-2xl font-medium">
          {learned ? 'Divo learned your workflow' : 'Teaching reviewed'}
        </h1>
        <p className="mt-2 max-w-md text-center leading-6 text-muted-foreground">
          {session?.understanding ?? (learned
            ? 'Your department persona now includes this working pattern.'
            : 'Divo found no safe, high-confidence persona change in this recording.')}
        </p>
        {learned && session.appliedChangeCount > 0 && (
          <Badge variant="secondary" className="mt-4">
            {session.appliedChangeCount} persona {session.appliedChangeCount === 1 ? 'rule' : 'rules'} updated
          </Badge>
        )}
        {session && (
          <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
            <FileVideo2 className="size-3.5" />
            <span>{session.originalFileName}</span>
            <span>·</span>
            <span>{formatBytes(session.fileSize)}</span>
          </div>
        )}
        {undoMessage && (
          <p className="mt-4 text-sm text-muted-foreground" role="status">{undoMessage}</p>
        )}
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          {learned && session.remainingUndos > 0 && (
            <Button variant="outline" onClick={() => void undo()} disabled={undoing}>
              <Undo2 /> {undoing ? 'Undoing…' : `Undo (${session.remainingUndos} left)`}
            </Button>
          )}
          <Button onClick={reset}>Teach another workflow</Button>
        </div>
      </CenteredCard>
    )
  }

  return (
    <CenteredCard>
      <div className="grid size-12 place-items-center rounded-xl bg-amber-500/10 text-amber-600">
        <FileVideo2 className="size-5" />
      </div>
      <h1 className="mt-5 font-studio text-2xl font-medium">
        {errorKind === 'manager'
          ? 'Manager access required'
          : errorKind === 'recorder'
            ? 'Screen recorder could not start'
            : 'Recording not prepared'}
      </h1>
      <p className="mt-2 max-w-md text-center leading-6 text-muted-foreground">
        {errorKind === 'manager'
          ? 'Teach currently learns only from the manager of the selected department.'
          : errorKind === 'recorder'
            ? 'Allow Screen & System Audio Recording and Microphone access for Divo in Mac System Settings, then try again.'
            : 'Divo could not prepare this recording. Your persona was not changed.'}
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
