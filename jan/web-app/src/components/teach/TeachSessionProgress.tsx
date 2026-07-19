import type { ComponentType } from 'react'
import {
  AudioLines,
  Check,
  FileVideo2,
  GitCompareArrows,
  Image,
  ScanText,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { TeachSession } from '@/lib/divo-teach'
import { cn } from '@/lib/utils'

type CompilingStep = Extract<
  TeachSession['processingStep'],
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
    detail:
      'Repeated screens are removed while meaningful visual changes are retained.',
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
    detail:
      'OCR is extracting the interface text needed to understand each step.',
  },
  {
    key: 'reconstructing_workflow',
    icon: GitCompareArrows,
    title: 'Compiling the teaching context',
    detail:
      'Screens and narration are being aligned into evidence for the Teach agent.',
  },
  {
    key: 'evidence_ready',
    icon: Check,
    title: 'Evidence ready',
    detail: 'The interactive Teach conversation is ready to begin.',
  },
]

/**
 * The whole arc, including the parts that are not this screen. Teach ends by
 * navigating into a chat thread; showing that as a named stage ahead of time
 * stops the handoff from reading as the app changing its mind.
 */
const RAIL = [
  { key: 'recorded', label: 'Recorded' },
  { key: 'uploaded', label: 'Uploaded' },
  { key: 'reading', label: 'Reading the recording' },
  { key: 'review', label: 'Review together' },
  { key: 'saved', label: 'Saved' },
] as const

function Rail({ activeIndex }: { activeIndex: number }) {
  return (
    <ol className="mb-6 flex items-center gap-0 overflow-x-auto">
      {RAIL.map((stage, index) => {
        const done = index < activeIndex
        const now = index === activeIndex
        return (
          <li
            key={stage.key}
            className={cn(
              'flex shrink-0 items-center gap-2',
              index < RAIL.length - 1 && 'flex-1'
            )}
          >
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full border bg-card font-mono text-[11px] text-muted-foreground',
                done &&
                  'border-emerald-500/35 bg-emerald-500/10 text-emerald-600',
                now && 'border-violet-500/40 bg-violet-500/12 text-violet-500'
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            <span
              className={cn(
                'whitespace-nowrap text-xs text-muted-foreground',
                now && 'font-medium text-foreground'
              )}
            >
              {stage.label}
            </span>
            {index < RAIL.length - 1 ? (
              <span
                className={cn(
                  'mx-2 hidden h-px flex-1 bg-border sm:block',
                  done && 'bg-emerald-500/35'
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Upload and evidence-compilation as one continuous session view. They were
 * two separate full-screen takeovers; uploading is seconds of work and never
 * deserved its own screen, and splitting them hid the fact that they are one
 * job the user is waiting on.
 */
export function TeachSessionProgress({
  session,
  uploading,
  uploadProgress,
  statusWarning,
  onCancel,
}: {
  session?: TeachSession
  uploading: boolean
  uploadProgress: number
  statusWarning?: string
  onCancel?: () => void
}) {
  const foundIndex = session
    ? steps.findIndex((step) => step.key === session.processingStep)
    : -1
  const activeIndex =
    foundIndex >= 0
      ? foundIndex
      : Math.max(
          0,
          Math.min(steps.length - 1, Math.floor((session?.progress ?? 0) / 16))
        )
  const activeStep = steps[activeIndex] ?? steps[0]!
  const ActiveIcon = uploading ? UploadCloud : activeStep.icon
  const percent = uploading ? uploadProgress : (session?.progress ?? 0)

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="teach-processing-experience"
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3 sm:px-7">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Preparing Teach
          </p>
          <p className="text-sm font-medium">
            {uploading
              ? 'Uploading your teaching'
              : 'Compiling your recording evidence'}
          </p>
        </div>
        <Badge variant="outline">Durable · safe to close</Badge>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <Rail activeIndex={uploading ? 1 : 2} />

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
            <main className="rounded-xl border bg-card">
              <div className="border-b p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex gap-3.5">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-violet-500/20 bg-violet-500/10 text-violet-500">
                      <ActiveIcon className="size-4 animate-pulse" />
                    </span>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Happening now
                      </p>
                      <h1 className="mt-1 font-studio text-xl font-medium">
                        {uploading
                          ? 'Uploading your recording'
                          : activeStep.title}
                      </h1>
                      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                        {uploading
                          ? 'The recording is streamed securely without loading the whole video into memory.'
                          : activeStep.detail}
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    {percent}%
                  </span>
                </div>
                <Progress value={percent} className="mt-5 h-1.5" />
                {statusWarning && (
                  <p className="mt-3 text-xs text-amber-600">{statusWarning}</p>
                )}
              </div>

              <div className="divide-y px-4 sm:px-5">
                {steps.map((step, index) => {
                  const Icon = step.icon
                  const completed = !uploading && index < activeIndex
                  const active = !uploading && index === activeIndex
                  return (
                    <div
                      key={step.key}
                      className={cn(
                        'flex gap-3 py-3.5',
                        !completed && !active && 'opacity-45'
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground',
                          completed &&
                            'border-emerald-500/20 bg-emerald-500/10 text-emerald-600',
                          active &&
                            'border-violet-500/20 bg-violet-500/10 text-violet-500'
                        )}
                      >
                        {completed ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Icon
                            className={cn(
                              'size-3.5',
                              active && 'animate-pulse'
                            )}
                          />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{step.title}</p>
                        {active && (
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {step.detail}
                          </p>
                        )}
                      </div>
                      {completed && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          done
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </main>

            <aside className="space-y-4">
              <section className="rounded-xl border bg-card p-4">
                <h2 className="text-sm font-medium">Evidence receipt</h2>
                <div className="mt-3 divide-y">
                  <Fact
                    icon={FileVideo2}
                    label="Recording"
                    value={formatDuration(session?.evidence?.durationSeconds)}
                  />
                  <Fact
                    icon={Image}
                    label="Selected screens"
                    value={
                      session?.evidence
                        ? String(session.evidence.frameCount)
                        : 'Preparing'
                    }
                  />
                  <Fact
                    icon={AudioLines}
                    label="Transcript"
                    value={
                      session?.evidence
                        ? `${session.evidence.transcriptSegmentCount} segments`
                        : 'Preparing'
                    }
                  />
                  <Fact
                    icon={ScanText}
                    label="OCR"
                    value={session?.evidence?.ocrModels.join(', ') || 'Preparing'}
                  />
                </div>
              </section>
              <div className="flex gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="font-medium">Nothing is saved yet.</span>{' '}
                  When this finishes, Divo opens a conversation and walks you
                  through what it thinks it learned. You approve each change
                  before it is written.
                </span>
              </div>
              {onCancel && (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={onCancel}
                >
                  Cancel teaching
                </Button>
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

function Fact({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2.5 py-3 first:pt-0 last:pb-0">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        {label}
      </span>
      <span className="max-w-36 truncate text-right text-xs font-medium">
        {value}
      </span>
    </div>
  )
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'Preparing'
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`
}
