import { memo, useMemo, useState } from 'react'
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CircleXIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { DotsLoader } from './DotsLoader'
import {
  readDivoSubagentDetails,
  type DivoSubagentChild,
  type DivoSubagentState,
} from '@/lib/pi/subagent'

type SubagentRunCardProps = {
  part: {
    type?: unknown
    toolName?: unknown
    toolCallId?: unknown
    input?: unknown
    output?: unknown
  }
}

function stateLabel(state: DivoSubagentState): string {
  switch (state) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Working'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Stopped'
  }
}

function StateIcon({ state, className }: { state: DivoSubagentState; className?: string }) {
  if (state === 'completed') return <CheckCircle2Icon className={cn('text-emerald-500', className)} />
  if (state === 'failed' || state === 'cancelled') return <CircleXIcon className={cn('text-destructive', className)} />
  if (state === 'running') return <LoaderCircleIcon className={cn('animate-spin text-primary', className)} />
  return <CircleIcon className={cn('text-muted-foreground/60', className)} />
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
  return `${Math.round(value / 1_000)}k`
}

function formatUsage(child: DivoSubagentChild): string | undefined {
  const { input, output, turns } = child.usage
  if (!input && !output && !turns) return undefined
  return [
    turns ? `${turns} ${turns === 1 ? 'turn' : 'turns'}` : undefined,
    input ? `↑${formatTokens(input)}` : undefined,
    output ? `↓${formatTokens(output)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

function elapsed(child: DivoSubagentChild): string | undefined {
  if (!child.startedAt) return undefined
  const start = Date.parse(child.startedAt)
  const end = child.endedAt ? Date.parse(child.endedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const seconds = Math.max(0, Math.round((end - start) / 1_000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function statusText(child: DivoSubagentChild): string {
  if (child.state === 'running' && child.activity.label) return child.activity.label
  if (child.state === 'failed' && child.error) return child.error
  return stateLabel(child.state)
}

/**
 * One child run, laid out the way Cursor lays out its subagents: a glyph, the
 * role, its model beside it in a dimmer weight, and the live activity on a
 * second line underneath.
 *
 * A running child's activity line shimmers. It is a tool call one level down,
 * so it gets the same running treatment as a tool row in the parent trace —
 * without it, a card of four working children looks completely static.
 */
const ChildRow = memo(({ child }: { child: DivoSubagentChild }) => {
  const [expanded, setExpanded] = useState(false)
  const usage = formatUsage(child)
  const duration = elapsed(child)
  const hasDetails = Boolean(child.events.length || child.outputPreview || child.finalOutput || child.error)
  const output = child.error || child.finalOutput || child.outputPreview
  const running = child.state === 'running' || child.state === 'queued'

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-start gap-2.5 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-muted/30"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        aria-expanded={hasDetails ? expanded : undefined}
        disabled={!hasDetails}
      >
        {/* A fixed line box so the glyph centres on the row's FIRST line
            rather than on the whole three-line block. Both branches share it,
            so settling never nudges the text sideways or down. */}
        <span className="flex h-5 shrink-0 items-center">
          {running ? (
            // Scatter, not wave: a child run is a whole agent working, and
            // several of these sit stacked. The busier rhythm keeps the group
            // reading as live rather than as a static list of labels.
            <DotsLoader variant="scatter" className="text-foreground/80" />
          ) : (
            <StateIcon state={child.state} className="size-4 shrink-0" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          {/* Role and model, mirroring Cursor's "name · model" head line. */}
          <span className="flex items-baseline gap-2">
            <span className={cn('text-sm capitalize', running ? 'text-foreground' : 'text-muted-foreground')}>
              {child.role}
            </span>
            {child.model && <span className="truncate text-[13px] text-muted-foreground/70">{child.model}</span>}
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground/70">
            {child.task}
          </span>
          {/* The live line. Once a child settles, "Completed" only repeats the
              check icon, so the row drops to its timings — or disappears
              entirely if there are none. */}
          {(running || duration || usage || child.error) && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground/80">
              {(running || child.error) && (
                <span className={cn('truncate', running && 'text-shimmer')}>
                  {statusText(child)}
                </span>
              )}
              {duration && <span className="shrink-0 text-muted-foreground/60">{duration}</span>}
              {usage && <span className="truncate text-muted-foreground/60">· {usage}</span>}
            </span>
          )}
        </span>
        {hasDetails && (
          <ChevronDownIcon
            className={cn(
              'mt-0.5 size-4 shrink-0 text-muted-foreground/50 opacity-0 transition-all group-hover:opacity-100',
              expanded && 'rotate-180 opacity-100'
            )}
          />
        )}
      </button>

      {expanded && (
        <div className="mb-1 ml-[9px] border-l border-border pl-4 text-xs">
          {child.events.length > 0 && (
            <ol className="space-y-1.5 text-muted-foreground">
              {child.events.map((event) => (
                <li key={`${child.id}-${event.seq}`} className="flex gap-2">
                  <span className="w-12 shrink-0 font-mono text-[10px] text-muted-foreground/65">#{event.seq}</span>
                  <span>{event.label || event.kind.replaceAll('_', ' ')}</span>
                </li>
              ))}
            </ol>
          )}
          {output && (
            <pre className={cn('mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/55 p-2 font-sans leading-relaxed text-muted-foreground', child.error && 'text-destructive')}>
              {output}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})

ChildRow.displayName = 'SubagentRunCardChild'

/** A run-scoped view of Pi's latest `divo_subagents` tool snapshot. */
export const SubagentRunCard = memo(({ part }: SubagentRunCardProps) => {
  const details = useMemo(
    () => readDivoSubagentDetails(part),
    [part.input, part.output, part.toolCallId]
  )
  const { summary } = details
  const active = summary.queued + summary.running
  const status =
    details.state === 'running'
      ? active
        ? `${summary.completed}/${summary.total} complete · ${active} active`
        : `${summary.completed}/${summary.total} complete`
      : details.state === 'completed'
        ? `${summary.completed}/${summary.total} complete`
        : details.state === 'cancelled'
          ? 'Stopped'
          : `${summary.completed}/${summary.total} complete · ${summary.failed} failed`

  const running = details.state === 'running'

  return (
    // Deliberately unboxed. Inside the work log this sits between plain tool
    // rows, and a bordered card there reads as a different kind of object —
    // the children are just a nested list of the same running steps.
    <section
      className="flex flex-col"
      data-testid="subagent-run-card"
      data-parent-tool-call-id={details.parentToolCallId}
    >
      <div className="flex items-center gap-2.5 py-0.5 text-sm">
        {running ? (
          <DotsLoader variant="scatter" className="text-foreground/80" />
        ) : (
          <BotIcon className="size-4 shrink-0 text-muted-foreground/70" />
        )}
        <span className={cn('text-[13px]', running && 'text-shimmer')}>
          {running ? 'Running' : 'Ran'} subagents
        </span>
        <span className="truncate text-[13px] text-muted-foreground/60">{status}</span>
      </div>
      <div className="mt-0.5 flex flex-col pl-[7px]">
        {details.children.map((child) => <ChildRow key={child.id} child={child} />)}
        {details.children.length === 0 && (
          <p className="px-1 py-1.5 text-[13px] text-muted-foreground/70">Preparing subagents…</p>
        )}
      </div>
    </section>
  )
})

SubagentRunCard.displayName = 'SubagentRunCard'
