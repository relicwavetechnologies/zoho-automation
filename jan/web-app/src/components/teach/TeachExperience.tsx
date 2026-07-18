import type { ComponentType } from 'react'
import { AudioLines, Check, FileVideo2, GitCompareArrows, Image, ScanText, ShieldCheck, UploadCloud } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { TeachSession } from '@/lib/divo-teach'
import { cn } from '@/lib/utils'

type CompilingStep = Extract<TeachSession['processingStep'],
  | 'recording_received'
  | 'selecting_evidence'
  | 'transcribing'
  | 'reading_screens'
  | 'reconstructing_workflow'
  | 'evidence_ready'
>

const steps: Array<{
  key: CompilingStep
  icon: ComponentType<{ className?: string }>
  title: string
  detail: string
}> = [
  {
    key: 'recording_received',
    icon: UploadCloud,
    title: 'Recording received',
    detail: 'The completed recording is stored safely for this Teach session.',
  },
  {
    key: 'selecting_evidence',
    icon: FileVideo2,
    title: 'Selecting useful screens',
    detail: 'Repeated screens are removed while meaningful visual changes are retained.',
  },
  {
    key: 'transcribing',
    icon: AudioLines,
    title: 'Transcribing your explanation',
    detail: 'Your narration is becoming timestamped workflow evidence.',
  },
  {
    key: 'reading_screens',
    icon: ScanText,
    title: 'Reading visible screen details',
    detail: 'OCR is extracting the interface text needed to understand each step.',
  },
  {
    key: 'reconstructing_workflow',
    icon: GitCompareArrows,
    title: 'Compiling the teaching context',
    detail: 'Screens and narration are being aligned into evidence for the Teach agent.',
  },
  {
    key: 'evidence_ready',
    icon: Check,
    title: 'Evidence ready',
    detail: 'The interactive Teach conversation is ready to begin.',
  },
]

export function TeachProcessingExperience({
  session,
  statusWarning,
  onCancel,
}: {
  session: TeachSession
  statusWarning?: string
  onCancel?: () => void
}) {
  const foundIndex = steps.findIndex(step => step.key === session.processingStep)
  const activeIndex = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(steps.length - 1, Math.floor(session.progress / 16)))
  const activeStep = steps[activeIndex] ?? steps[0]!
  const ActiveIcon = activeStep.icon

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="teach-processing-experience">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3 sm:px-7">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Preparing Teach</p>
          <p className="text-sm font-medium">Compiling your recording evidence</p>
        </div>
        <Badge variant="outline">Durable job</Badge>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <main className="rounded-xl border bg-card">
            <div className="border-b p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex gap-3.5">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-violet-500/20 bg-violet-500/10 text-violet-500">
                    <ActiveIcon className="size-4 animate-pulse" />
                  </span>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Happening now</p>
                    <h1 className="mt-1 font-studio text-xl font-medium">{activeStep.title}</h1>
                    <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{activeStep.detail}</p>
                  </div>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{session.progress}%</span>
              </div>
              <Progress value={session.progress} className="mt-5 h-1.5" />
              {statusWarning && <p className="mt-3 text-xs text-amber-600">{statusWarning}</p>}
            </div>

            <div className="divide-y px-4 sm:px-5">
              {steps.map((step, index) => {
                const Icon = step.icon
                const completed = index < activeIndex
                const active = index === activeIndex
                return (
                  <div key={step.key} className={cn('flex gap-3 py-3.5', !completed && !active && 'opacity-45')}>
                    <span className={cn(
                      'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground',
                      completed && 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600',
                      active && 'border-violet-500/20 bg-violet-500/10 text-violet-500'
                    )}>
                      {completed ? <Check className="size-3.5" /> : <Icon className={cn('size-3.5', active && 'animate-pulse')} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{step.title}</p>
                      {active && <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>}
                    </div>
                    {completed && <span className="font-mono text-[10px] text-muted-foreground">done</span>}
                  </div>
                )
              })}
            </div>
          </main>

          <aside className="space-y-4">
            <section className="rounded-xl border bg-card p-4">
              <h2 className="text-sm font-medium">Evidence receipt</h2>
              <div className="mt-3 divide-y">
                <Fact icon={FileVideo2} label="Recording" value={formatDuration(session.evidence?.durationSeconds)} />
                <Fact icon={Image} label="Selected screens" value={session.evidence ? String(session.evidence.frameCount) : 'Preparing'} />
                <Fact icon={AudioLines} label="Transcript" value={session.evidence ? `${session.evidence.transcriptSegmentCount} segments` : 'Preparing'} />
                <Fact icon={ScanText} label="OCR" value={session.evidence?.ocrModels.join(', ') || 'Preparing'} />
              </div>
            </section>
            <div className="flex gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-600" />
              This stage prepares evidence only. Divo will show the reasoning and every confirmed write in the following conversation.
            </div>
          </aside>
        </div>
      </div>

      {onCancel && (
        <div className="flex shrink-0 justify-end border-t px-5 py-3 sm:px-7">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel teaching</Button>
        </div>
      )}
    </div>
  )
}

function Fact({ icon: Icon, label, value }: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2.5 py-3 first:pt-0 last:pb-0">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{label}</span>
      <span className="max-w-36 truncate text-right text-xs font-medium">{value}</span>
    </div>
  )
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'Preparing'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`
}
