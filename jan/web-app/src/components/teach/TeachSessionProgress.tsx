import type { ComponentType } from 'react'
import {
  AudioLines,
  Check,
  Eye,
  FileVideo2,
  ListChecks,
  RotateCcw,
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

/**
 * The stages, named for what they mean to the person waiting.
 *
 * These used to be described in the vocabulary of the pipeline that runs them
 * — "OCR is extracting the interface text", "aligned into evidence for the
 * Teach agent". A manager watching a progress bar does not need the mechanism;
 * they need to know that something sensible is happening to their recording
 * and roughly how far along it is.
 */
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
    detail: 'Your video is safely with Divo.',
  },
  {
    key: 'selecting_evidence',
    icon: FileVideo2,
    title: 'Finding the moments that matter',
    detail: 'Divo skips the parts where nothing changed on screen.',
  },
  {
    key: 'transcribing',
    icon: AudioLines,
    title: 'Listening to what you said',
    detail: 'Your explanation is what turns the clicks into a rule.',
  },
  {
    key: 'reading_screens',
    icon: ScanText,
    title: 'Reading what was on screen',
    detail: 'Divo reads the text in each step so it understands the context.',
  },
  {
    key: 'reconstructing_workflow',
    icon: ListChecks,
    title: 'Putting your steps in order',
    detail: 'Working out what you did, and why you did it that way.',
  },
  {
    key: 'evidence_ready',
    icon: Check,
    title: 'Ready to talk it through',
    detail: 'Divo will open a chat to check what it understood.',
  },
]

/**
 * The whole arc, including the parts that are not this screen. Teach ends by
 * navigating into a chat thread; showing that as a named stage ahead of time
 * stops the handoff from reading as the app changing its mind.
 */
const RAIL = [
  { key: 'recorded', label: 'Recorded' },
  { key: 'uploaded', label: 'Sent' },
  { key: 'reading', label: 'Divo watches it' },
  { key: 'review', label: 'You check it together' },
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
 * Sending and watching as one continuous wait.
 *
 * They were two separate full-screen takeovers; sending is seconds of work and
 * never deserved its own screen, and splitting them hid the fact that they are
 * one job the manager is waiting on. The one thing this screen must never
 * imply is that the manager has to sit here for it — so that is said outright,
 * at the top, in the badge and again beside the progress bar.
 */
export function TeachSessionProgress({
  session,
  uploading,
  uploadProgress,
  statusWarning,
  stuck,
  resuming,
  onResume,
  onClose,
  onCancel,
}: {
  session?: TeachSession
  uploading: boolean
  uploadProgress: number
  statusWarning?: string
  /** Progress has not moved for long enough to offer a restart. */
  stuck?: boolean
  resuming?: boolean
  onResume?: () => void
  /** Leave the waiting screen without touching the work. */
  onClose?: () => void
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
  // The session exists but Divo never received the video — a send that
  // dropped and is queued for another try. Claiming "Divo is watching it"
  // here was simply untrue, and the step list below meant nothing yet.
  const waitingToSend = !uploading && session?.status === 'awaiting_upload'
  const ActiveIcon = uploading || waitingToSend ? UploadCloud : activeStep.icon
  const percent = uploading
    ? uploadProgress
    : waitingToSend
      ? 0
      : (session?.progress ?? 0)

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="teach-processing-experience"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3 sm:px-7">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Teaching in progress
          </p>
          <p className="text-sm font-medium">
            {uploading
              ? 'Sending your recording'
              : waitingToSend
                ? 'Waiting to send'
                : 'Divo is watching it'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">Keeps running if you close this</Badge>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <Rail activeIndex={uploading || waitingToSend ? 1 : 2} />

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
                          ? 'Sending your recording'
                          : waitingToSend
                            ? 'Waiting to send'
                            : activeStep.title}
                      </h1>
                      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                        {uploading
                          ? 'This can take a few minutes on a slow connection. It carries on in the background if you leave.'
                          : waitingToSend
                            ? 'Your recording is saved on this Mac. Divo retries on its own as soon as it can reach the service.'
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
                  const started = !uploading && !waitingToSend
                  const completed = started && index < activeIndex
                  const active = started && index === activeIndex
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
              <div className="flex gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="font-medium">Nothing has changed yet.</span>{' '}
                  When Divo has finished watching, it opens a chat and tells you
                  what it thinks it learned. You approve every change before it
                  is saved.
                </span>
              </div>

              <div className="flex gap-2.5 rounded-xl border p-3.5 text-xs leading-5 text-muted-foreground">
                <Eye className="mt-0.5 size-4 shrink-0" />
                <span>
                  You do not have to wait here. Close this and keep working —
                  the sidebar shows how it is going, and Divo tells you when it
                  needs you.
                </span>
              </div>

              {stuck && onResume && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3.5">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                    This looks stuck
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Divo has not made progress for a while. Your recording is
                    safe — starting it again usually sorts it out.
                  </p>
                  <Button
                    size="sm"
                    className="mt-3 w-full"
                    disabled={resuming}
                    onClick={onResume}
                    data-testid="resume-teach-session"
                  >
                    <RotateCcw /> {resuming ? 'Starting again…' : 'Start it again'}
                  </Button>
                </div>
              )}

              {onCancel && (
                <Button variant="ghost" className="w-full" onClick={onCancel}>
                  Stop and throw this away
                </Button>
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
