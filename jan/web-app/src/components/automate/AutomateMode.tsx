import { useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  AppWindow,
  ArrowLeft,
  AudioLines,
  Bot,
  BrainCircuit,
  CalendarClock,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Clock3,
  Eye,
  LockKeyhole,
  Mail,
  Mic,
  MousePointer2,
  Pause,
  PencilLine,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Table2,
  Workflow,
  Zap,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type AutomateStage =
  | 'intro'
  | 'permissions'
  | 'recording'
  | 'analyzing'
  | 'review'
  | 'ready'

type PermissionKey = 'screen' | 'microphone' | 'activity'

const permissionItems: Array<{
  id: PermissionKey
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
}> = [
  {
    id: 'screen',
    icon: Camera,
    title: 'Screen snapshots',
    description: 'Capture meaningful visual changes while you demonstrate.',
  },
  {
    id: 'microphone',
    icon: Mic,
    title: 'Microphone',
    description: 'Hear your explanation of why each step matters.',
  },
  {
    id: 'activity',
    icon: AppWindow,
    title: 'App context',
    description: 'Record active app names and relevant website domains.',
  },
]

const workflowSteps = [
  {
    title: 'Open the Sales Pipeline sheet',
    description: 'Use the North America view in Google Sheets.',
    evidence: 'Screen + app context',
    icon: Table2,
  },
  {
    title: 'Find leads waiting more than 5 days',
    description: 'Filter Status to Follow-up and Last contacted to 5+ days.',
    evidence: 'Narration + screen',
    icon: Eye,
  },
  {
    title: 'Draft a personalized follow-up',
    description: 'Use the lead name, company and last conversation in Gmail.',
    evidence: 'App change + narration',
    icon: Mail,
  },
  {
    title: 'Review before sending',
    description: 'Show every draft to the account owner for final approval.',
    evidence: 'Explicit instruction',
    icon: ShieldCheck,
  },
]

const formatDuration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function AutomateMode() {
  const [stage, setStage] = useState<AutomateStage>('intro')
  const [permissions, setPermissions] = useState<Record<PermissionKey, boolean>>({
    screen: true,
    microphone: true,
    activity: true,
  })
  const [seconds, setSeconds] = useState(0)
  const [paused, setPaused] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState(0)
  const [showCorrection, setShowCorrection] = useState(false)
  const [correction, setCorrection] = useState('')
  const [markedSteps, setMarkedSteps] = useState(1)

  useEffect(() => {
    if (stage !== 'recording' || paused) return
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [paused, stage])

  useEffect(() => {
    if (stage !== 'analyzing') return
    setAnalysisProgress(8)
    const timer = window.setInterval(() => {
      setAnalysisProgress((value) => Math.min(value + 7, 96))
    }, 240)
    return () => window.clearInterval(timer)
  }, [stage])

  const enabledPermissions = useMemo(
    () => Object.values(permissions).filter(Boolean).length,
    [permissions]
  )

  const startOver = () => {
    setStage('intro')
    setSeconds(0)
    setPaused(false)
    setAnalysisProgress(0)
    setShowCorrection(false)
    setCorrection('')
    setMarkedSteps(1)
  }

  if (stage === 'intro') {
    return <AutomateIntro onStart={() => setStage('permissions')} />
  }

  if (stage === 'permissions') {
    return (
      <PermissionSetup
        permissions={permissions}
        enabledCount={enabledPermissions}
        onBack={() => setStage('intro')}
        onToggle={(id, value) =>
          setPermissions((current) => ({ ...current, [id]: value }))
        }
        onStart={() => setStage('recording')}
      />
    )
  }

  if (stage === 'recording') {
    return (
      <RecordingSession
        duration={formatDuration(seconds)}
        markedSteps={markedSteps}
        paused={paused}
        onCancel={startOver}
        onMarkStep={() => setMarkedSteps((value) => value + 1)}
        onPause={() => setPaused((value) => !value)}
        onFinish={() => setStage('analyzing')}
      />
    )
  }

  if (stage === 'analyzing') {
    return (
      <AnalysisView
        progress={analysisProgress}
        onContinue={() => {
          setAnalysisProgress(100)
          setStage('review')
        }}
      />
    )
  }

  if (stage === 'review') {
    return (
      <UnderstandingReview
        correction={correction}
        showCorrection={showCorrection}
        onBack={() => setStage('analyzing')}
        onCorrectionChange={setCorrection}
        onShowCorrection={() => setShowCorrection(true)}
        onConfirm={() => setStage('ready')}
      />
    )
  }

  return (
    <AutomationReady
      onBack={() => setStage('review')}
      onStartOver={startOver}
    />
  )
}

function AutomateIntro({ onStart }: { onStart: () => void }) {
  return (
    <div className="h-full overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center py-6">
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_0.9fr]">
          <div>
            <Badge variant="outline" className="mb-5 border-primary/25 bg-primary/5 text-primary">
              <Sparkles className="size-3" />
              Workflow learning
            </Badge>
            <h1 className="max-w-xl font-studio text-3xl font-medium tracking-tight sm:text-4xl">
              Show Divo how your work gets done.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
              Walk through a real task and explain what you are doing. Divo will
              turn your demonstration into a workflow you can review, test and reuse.
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={onStart} data-testid="start-workflow-recording">
                <span className="relative flex size-3 items-center justify-center">
                  <span className="absolute size-3 animate-ping rounded-full bg-white/35" />
                  <span className="relative size-2 rounded-full bg-current" />
                </span>
                Record workflow
              </Button>
              <span className="text-xs text-muted-foreground">Nothing starts until you approve access.</span>
            </div>

            <div className="mt-9 grid max-w-xl gap-3 sm:grid-cols-3">
              <IntroSignal icon={Camera} label="Key screenshots" />
              <IntroSignal icon={AudioLines} label="Your explanation" />
              <IntroSignal icon={AppWindow} label="Apps you use" />
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-md">
            <div className="absolute -inset-6 rounded-[2rem] bg-primary/8 blur-3xl" />
            <div className="relative overflow-hidden rounded-2xl border bg-card shadow-xl shadow-black/5">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-red-500" />
                  <span className="text-xs font-medium">Learning a workflow</span>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">02:18</span>
              </div>
              <div className="space-y-1.5 p-3">
                <MockTimelineItem icon={Table2} time="00:12" title="Opened Sales Pipeline" detail="Google Sheets" active />
                <MockTimelineItem icon={MousePointer2} time="00:38" title="Filtered overdue leads" detail="Screen change detected" />
                <MockTimelineItem icon={AudioLines} time="01:05" title="Explained the follow-up rule" detail="Voice note transcribed" />
                <MockTimelineItem icon={Mail} time="01:42" title="Drafted follow-up email" detail="Gmail" />
              </div>
              <div className="border-t bg-muted/30 px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <BrainCircuit className="size-3.5 text-primary" />
                  Divo keeps evidence aligned on one timeline
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function IntroSignal({ icon: Icon, label }: { icon: ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card/70 px-3 py-2.5 text-sm">
      <span className="grid size-7 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      {label}
    </div>
  )
}

function MockTimelineItem({
  icon: Icon,
  time,
  title,
  detail,
  active = false,
}: {
  icon: ComponentType<{ className?: string }>
  time: string
  title: string
  detail: string
  active?: boolean
}) {
  return (
    <div className={cn('flex gap-3 rounded-xl p-3', active && 'bg-primary/7')}>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg border bg-background', active && 'border-primary/25 text-primary')}>
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-medium">{title}</p>
          <span className="font-mono text-[10px] text-muted-foreground">{time}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

function PermissionSetup({
  permissions,
  enabledCount,
  onBack,
  onToggle,
  onStart,
}: {
  permissions: Record<PermissionKey, boolean>
  enabledCount: number
  onBack: () => void
  onToggle: (id: PermissionKey, value: boolean) => void
  onStart: () => void
}) {
  return (
    <div className="h-full overflow-y-auto px-5 py-8">
      <div className="mx-auto max-w-2xl py-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-5 -ml-2">
          <ArrowLeft /> Back
        </Button>
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b p-6 sm:p-7">
            <div className="mb-5 grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
              <LockKeyhole className="size-5" />
            </div>
            <h1 className="font-studio text-2xl font-medium">Choose what Divo can observe</h1>
            <p className="mt-2 max-w-lg leading-6 text-muted-foreground">
              These signals are used only for this teaching session. You can pause or stop at any time.
            </p>
          </div>

          <div className="divide-y px-6 sm:px-7">
            {permissionItems.map((item) => {
              const Icon = item.icon
              return (
                <label key={item.id} className="flex cursor-pointer items-center gap-4 py-5">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-muted/40 text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.title}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{item.description}</span>
                  </span>
                  <Switch
                    checked={permissions[item.id]}
                    onCheckedChange={(value) => onToggle(item.id, value)}
                    aria-label={`Allow ${item.title}`}
                  />
                </label>
              )
            })}
          </div>

          <div className="rounded-b-2xl border-t bg-muted/25 p-6 sm:px-7">
            <div className="mb-5 flex gap-3 rounded-xl border border-emerald-500/15 bg-emerald-500/5 p-3 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              Password fields and excluded apps stay out of the session. You review the result before anything is saved as a workflow.
            </div>
            <Button className="w-full" size="lg" disabled={enabledCount === 0} onClick={onStart}>
              Allow {enabledCount} sources & start
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RecordingSession({
  duration,
  markedSteps,
  paused,
  onCancel,
  onMarkStep,
  onPause,
  onFinish,
}: {
  duration: string
  markedSteps: number
  paused: boolean
  onCancel: () => void
  onMarkStep: () => void
  onPause: () => void
  onFinish: () => void
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3 sm:px-7">
        <div className="flex items-center gap-3">
          <span className="relative flex size-3 items-center justify-center">
            {!paused && <span className="absolute size-3 animate-ping rounded-full bg-red-500/30" />}
            <span className={cn('relative size-2 rounded-full', paused ? 'bg-amber-500' : 'bg-red-500')} />
          </span>
          <div>
            <p className="text-sm font-medium">{paused ? 'Recording paused' : 'Learning your workflow'}</p>
            <p className="text-xs text-muted-foreground">Narrate the decisions that are not visible on screen.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono tabular-nums"><Clock3 /> {duration}</Badge>
          <Badge variant="secondary">Mock session</Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="overflow-hidden rounded-2xl border bg-zinc-950 shadow-lg shadow-black/10">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5 text-white">
              <div className="flex items-center gap-2 text-xs">
                <AppWindow className="size-3.5 text-emerald-400" />
                Google Chrome · docs.google.com
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-white/45">
                <Eye className="size-3" /> Screen visible
                <span className="mx-1 text-white/20">·</span>
                <Mic className="size-3 text-emerald-400" /> Listening
              </div>
            </div>
            <div className={cn('relative aspect-[16/9] overflow-hidden bg-[#f7f8f9] transition-opacity', paused && 'opacity-45')}>
              <MockSpreadsheet />
              {paused && (
                <div className="absolute inset-0 grid place-items-center bg-zinc-950/25 backdrop-blur-[2px]">
                  <div className="rounded-full bg-zinc-950/80 px-4 py-2 text-sm font-medium text-white">Paused</div>
                </div>
              )}
            </div>
          </div>

          <aside className="flex min-h-[25rem] flex-col rounded-2xl border bg-card">
            <div className="border-b p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Live activity</p>
                <Badge variant="secondary">{markedSteps} marked</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">What Divo has noticed so far</p>
            </div>
            <div className="flex-1 space-y-1 p-2">
              <LiveEvent time="00:03" icon={AppWindow} title="Chrome active" detail="docs.google.com" />
              <LiveEvent time="00:11" icon={Camera} title="Screen change captured" detail="Sales Pipeline sheet" />
              <LiveEvent time="00:18" icon={AudioLines} title="Narration detected" detail="“I start with overdue leads…”" active />
              {markedSteps > 1 && <LiveEvent time="now" icon={Zap} title="Important step marked" detail="Added by you" active />}
            </div>
            <div className="border-t p-3">
              <Button variant="outline" className="w-full" onClick={onMarkStep} disabled={paused}>
                <Zap /> Mark important step
              </Button>
            </div>
          </aside>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background/95 px-5 py-3 sm:px-7">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel session</Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onPause}>{paused ? <Play /> : <Pause />}{paused ? 'Resume' : 'Pause'}</Button>
          <Button onClick={onFinish}><CircleStop /> Finish recording</Button>
        </div>
      </div>
    </div>
  )
}

function MockSpreadsheet() {
  const rows = [
    ['Aster Labs', 'Maya Chen', 'Follow-up', '8 days', '$24,000'],
    ['Northwind', 'Jamie Cole', 'Qualified', '2 days', '$18,500'],
    ['Redwood Co.', 'Nina Shah', 'Follow-up', '6 days', '$31,200'],
    ['Orbital', 'Sam Ortiz', 'Proposal', '1 day', '$42,000'],
    ['Canvas Works', 'Ira Patel', 'Follow-up', '11 days', '$16,800'],
  ]
  return (
    <div className="absolute inset-0 text-[10px] text-zinc-700">
      <div className="flex h-9 items-center gap-3 border-b bg-white px-3">
        <span className="grid size-5 place-items-center rounded bg-emerald-600 text-[9px] font-bold text-white">S</span>
        <span className="font-medium">Sales Pipeline — North America</span>
        <span className="ml-auto rounded bg-emerald-600 px-2.5 py-1 text-[9px] font-medium text-white">Share</span>
      </div>
      <div className="flex h-7 items-center gap-3 border-b bg-white px-3 text-[9px] text-zinc-500">
        <span>File</span><span>Edit</span><span>View</span><span>Data</span><span>Tools</span>
      </div>
      <div className="flex h-8 items-center gap-2 border-b bg-white px-3">
        <span className="rounded border bg-zinc-50 px-2 py-1">Filter: Follow-up</span>
        <span className="rounded border bg-zinc-50 px-2 py-1">Last contact: 5+ days</span>
      </div>
      <div className="m-3 overflow-hidden rounded border bg-white">
        <div className="grid grid-cols-[1.3fr_1fr_1fr_.8fr_.8fr] bg-zinc-100 font-medium">
          {['Company', 'Owner', 'Status', 'Last contact', 'Value'].map((cell) => <div key={cell} className="border-r px-2 py-2">{cell}</div>)}
        </div>
        {rows.map((row, rowIndex) => (
          <div key={row[0]} className={cn('grid grid-cols-[1.3fr_1fr_1fr_.8fr_.8fr]', [0, 2, 4].includes(rowIndex) && 'bg-emerald-50/70')}>
            {row.map((cell, cellIndex) => <div key={cell} className={cn('border-r border-t px-2 py-2.5', cellIndex === 2 && cell === 'Follow-up' && 'font-medium text-amber-700')}>{cell}</div>)}
          </div>
        ))}
      </div>
      <div className="absolute bottom-3 left-3 rounded-lg bg-zinc-900 px-3 py-2 text-[10px] text-white shadow-lg">
        3 overdue leads found
      </div>
    </div>
  )
}

function LiveEvent({ time, icon: Icon, title, detail, active = false }: { time: string; icon: ComponentType<{ className?: string }>; title: string; detail: string; active?: boolean }) {
  return (
    <div className="flex gap-2.5 rounded-xl p-2.5">
      <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground', active && 'bg-primary/10 text-primary')}><Icon className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2"><p className="truncate text-xs font-medium">{title}</p><span className="font-mono text-[9px] text-muted-foreground">{time}</span></div>
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

function AnalysisView({ progress, onContinue }: { progress: number; onContinue: () => void }) {
  const tasks = [
    { label: 'Transcribing your explanation', threshold: 18 },
    { label: 'Reading screenshots and app context', threshold: 42 },
    { label: 'Reconstructing workflow steps', threshold: 68 },
    { label: 'Mapping Divo tools and skills', threshold: 90 },
  ]
  return (
    <div className="grid h-full place-items-center overflow-y-auto px-5 py-10">
      <div className="w-full max-w-xl text-center">
        <div className="relative mx-auto mb-7 grid size-20 place-items-center rounded-3xl border bg-card shadow-lg shadow-primary/10">
          <div className="absolute inset-2 animate-pulse rounded-2xl bg-primary/10" />
          <BrainCircuit className="relative size-8 text-primary" />
        </div>
        <Badge variant="secondary" className="mb-4">Deep analysis</Badge>
        <h1 className="font-studio text-2xl font-medium">Divo is understanding your workflow</h1>
        <p className="mx-auto mt-2 max-w-md leading-6 text-muted-foreground">Connecting what you said with what happened on screen, then checking which company capabilities can perform it.</p>

        <div className="mt-8 rounded-2xl border bg-card p-5 text-left shadow-sm">
          <div className="mb-5 flex items-center gap-3">
            <Progress value={progress} className="h-1.5 flex-1" />
            <span className="w-9 text-right font-mono text-[11px] text-muted-foreground">{progress}%</span>
          </div>
          <div className="space-y-1">
            {tasks.map((task) => {
              const complete = progress >= task.threshold
              return (
                <div key={task.label} className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm">
                  <span className={cn('grid size-5 place-items-center rounded-full border text-muted-foreground', complete && 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600')}>
                    {complete ? <Check className="size-3" /> : <span className="size-1.5 animate-pulse rounded-full bg-current" />}
                  </span>
                  <span className={cn(!complete && 'text-muted-foreground')}>{task.label}</span>
                </div>
              )
            })}
          </div>
          <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
            <EvidenceChip icon={Camera} label="14 screenshots" />
            <EvidenceChip icon={AudioLines} label="2m 18s narration" />
            <EvidenceChip icon={AppWindow} label="2 apps" />
          </div>
        </div>

        <Button variant="ghost" size="sm" className="mt-5" onClick={onContinue}>View mock result now <ChevronRight /></Button>
      </div>
    </div>
  )
}

function EvidenceChip({ icon: Icon, label }: { icon: ComponentType<{ className?: string }>; label: string }) {
  return <Badge variant="outline" className="font-normal text-muted-foreground"><Icon /> {label}</Badge>
}

function UnderstandingReview({
  correction,
  showCorrection,
  onBack,
  onCorrectionChange,
  onShowCorrection,
  onConfirm,
}: {
  correction: string
  showCorrection: boolean
  onBack: () => void
  onCorrectionChange: (value: string) => void
  onShowCorrection: () => void
  onConfirm: () => void
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3 sm:px-7">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back to analysis"><ArrowLeft /></Button>
          <div><p className="text-sm font-medium">Review Divo's understanding</p><p className="text-xs text-muted-foreground">Nothing has been automated yet.</p></div>
        </div>
        <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"><CheckCircle2 /> 92% confidence</Badge>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <main>
            <div className="mb-5 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
              <div className="flex items-start gap-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Workflow className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h1 className="font-studio text-xl font-medium">Follow up with overdue sales leads</h1><Badge variant="secondary">Draft</Badge></div>
                  <p className="mt-2 leading-6 text-muted-foreground">Every Monday, find leads that have waited more than five days and prepare personalized follow-up emails for account-owner approval.</p>
                </div>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between px-1"><div><h2 className="text-sm font-medium">Understood steps</h2><p className="mt-0.5 text-xs text-muted-foreground">Built from your recording evidence</p></div><Button variant="ghost" size="sm" onClick={onShowCorrection}><PencilLine /> Correct Divo</Button></div>
            <div className="space-y-2">
              {workflowSteps.map((step, index) => {
                const Icon = step.icon
                return (
                  <div key={step.title} className="group flex gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-primary/25">
                    <div className="flex flex-col items-center"><span className="grid size-8 place-items-center rounded-full border bg-background text-xs font-medium">{index + 1}</span>{index < workflowSteps.length - 1 && <span className="mt-2 h-full w-px bg-border" />}</div>
                    <div className="min-w-0 flex-1 pb-1"><div className="flex items-center gap-2"><Icon className="size-3.5 text-muted-foreground" /><p className="text-sm font-medium">{step.title}</p></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p><Badge variant="outline" className="mt-2 font-normal text-muted-foreground">{step.evidence}</Badge></div>
                  </div>
                )
              })}
            </div>

            {showCorrection && (
              <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
                <label className="text-sm font-medium" htmlFor="workflow-correction">What did Divo misunderstand?</label>
                <p className="mt-1 text-xs text-muted-foreground">Your correction will update this draft, not an active company skill.</p>
                <Textarea id="workflow-correction" value={correction} onChange={(event) => onCorrectionChange(event.target.value)} className="mt-3 min-h-24 bg-background" placeholder="Example: Only contact leads owned by my team, and create drafts—never send automatically." />
                <div className="mt-3 flex justify-end"><Button size="sm" variant="outline" disabled={!correction.trim()} onClick={() => onCorrectionChange('')}>Apply correction</Button></div>
              </div>
            )}
          </main>

          <aside className="space-y-4">
            <ReviewPanel title="Capability map" icon={Zap}>
              <Capability icon={Table2} name="Google Sheets" detail="Read and filter pipeline" status="Ready" />
              <Capability icon={Mail} name="Gmail" detail="Create email drafts" status="Ready" />
              <Capability icon={CalendarClock} name="Scheduler" detail="Every Monday at 9:00" status="Ready" />
            </ReviewPanel>
            <ReviewPanel title="Safety & control" icon={ShieldCheck}>
              <ReviewRow label="Trigger" value="Weekly" />
              <ReviewRow label="Send emails" value="Never" />
              <ReviewRow label="Human review" value="Required" positive />
              <ReviewRow label="Publish scope" value="Only me" />
            </ReviewPanel>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-5 text-muted-foreground"><Bot className="mb-2 size-4 text-amber-600" /><strong className="text-foreground">One assumption:</strong> Divo interpreted “weekly” as Monday at 9:00 AM. You can change this before publishing.</div>
          </aside>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t bg-background/95 px-5 py-3 sm:px-7">
        <p className="hidden text-xs text-muted-foreground sm:block">Confirming creates a testable draft. It does not run it.</p>
        <div className="ml-auto flex gap-2"><Button variant="outline" onClick={onShowCorrection}>Needs changes</Button><Button onClick={onConfirm}><Check /> Yes, this is correct</Button></div>
      </div>
    </div>
  )
}

function ReviewPanel({ title, icon: Icon, children }: { title: string; icon: ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return <div className="rounded-xl border bg-card p-4"><div className="mb-3 flex items-center gap-2 text-sm font-medium"><Icon className="size-4 text-primary" />{title}</div><div className="space-y-2">{children}</div></div>
}

function Capability({ icon: Icon, name, detail, status }: { icon: ComponentType<{ className?: string }>; name: string; detail: string; status: string }) {
  return <div className="flex items-center gap-2.5 rounded-lg bg-muted/50 p-2.5"><span className="grid size-7 place-items-center rounded-md border bg-background"><Icon className="size-3.5" /></span><div className="min-w-0 flex-1"><p className="text-xs font-medium">{name}</p><p className="truncate text-[10px] text-muted-foreground">{detail}</p></div><span className="text-[10px] font-medium text-emerald-600">{status}</span></div>
}

function ReviewRow({ label, value, positive = false }: { label: string; value: string; positive?: boolean }) {
  return <div className="flex items-center justify-between gap-3 border-b py-2 text-xs last:border-0"><span className="text-muted-foreground">{label}</span><span className={cn('text-right font-medium', positive && 'text-emerald-600')}>{value}</span></div>
}

function AutomationReady({ onBack, onStartOver }: { onBack: () => void; onStartOver: () => void }) {
  return (
    <div className="grid h-full place-items-center overflow-y-auto px-5 py-10">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto mb-6 grid size-16 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600"><CheckCircle2 className="size-8" /></div>
        <Badge variant="outline" className="mb-4 border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400">Understanding confirmed</Badge>
        <h1 className="font-studio text-3xl font-medium">Your automation draft is ready to test.</h1>
        <p className="mx-auto mt-3 max-w-lg leading-6 text-muted-foreground">Divo will prepare the weekly follow-ups and pause before any email action. You stay in control while the workflow learns from corrections.</p>

        <div className="mt-8 overflow-hidden rounded-2xl border bg-card text-left shadow-sm">
          <div className="flex items-center gap-4 border-b p-5"><span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><Workflow className="size-5" /></span><div className="min-w-0 flex-1"><p className="font-medium">Follow up with overdue sales leads</p><p className="mt-0.5 text-xs text-muted-foreground">4 steps · 3 capabilities · human review required</p></div><Badge variant="secondary">Draft v1</Badge></div>
          <div className="grid gap-px bg-border sm:grid-cols-3">
            <ReadyDetail icon={CalendarClock} label="Starts" value="Monday, 9:00 AM" />
            <ReadyDetail icon={ShieldCheck} label="Approval" value="Before email drafts" />
            <ReadyDetail icon={Eye} label="Visibility" value="Only me" />
          </div>
        </div>

        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button size="lg"><Play /> Test with sample data</Button>
          <Button size="lg" variant="outline" onClick={onBack}>Back to understanding</Button>
        </div>
        <Button variant="ghost" size="sm" className="mt-3 text-muted-foreground" onClick={onStartOver}><RotateCcw /> Record another workflow</Button>
        <p className="mt-5 text-[11px] text-muted-foreground">Mock preview — no workflow, trigger or skill has been created.</p>
      </div>
    </div>
  )
}

function ReadyDetail({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
  return <div className="bg-card p-4"><Icon className="mb-3 size-4 text-muted-foreground" /><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-xs font-medium">{value}</p></div>
}
