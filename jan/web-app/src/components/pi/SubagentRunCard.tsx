import { memo, useMemo, useState } from 'react'
import {
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CircleXIcon,
  Clock3Icon,
  LoaderCircleIcon,
  WrenchIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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

const ChildRow = memo(({ child }: { child: DivoSubagentChild }) => {
  const [expanded, setExpanded] = useState(false)
  const usage = formatUsage(child)
  const duration = elapsed(child)
  const hasDetails = Boolean(child.events.length || child.outputPreview || child.finalOutput || child.error)
  const output = child.error || child.finalOutput || child.outputPreview

  return (
    <div className="rounded-md border border-border/70 bg-background/45">
      <button
        type="button"
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/35"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        aria-expanded={hasDetails ? expanded : undefined}
        disabled={!hasDetails}
      >
        <StateIcon state={child.state} className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-medium text-foreground capitalize">{child.role}</span>
            {child.model && <span className="truncate text-xs text-muted-foreground">{child.model}</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{child.task}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {child.activity.kind === 'tool' ? <WrenchIcon className="size-3 shrink-0" /> : <Clock3Icon className="size-3 shrink-0" />}
            <span className="truncate">{statusText(child)}</span>
            {duration && <span className="shrink-0">· {duration}</span>}
            {usage && <span className="truncate">· {usage}</span>}
          </span>
        </span>
        {hasDetails && <ChevronDownIcon className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />}
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-3 py-2.5 text-xs">
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

  return (
    <section
      className="rounded-lg border border-border bg-card/75 shadow-xs"
      data-testid="subagent-run-card"
      data-parent-tool-call-id={details.parentToolCallId}
    >
      <div className="flex items-center gap-2.5 border-b border-border/70 px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <BotIcon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Subagents</span>
          <span className="block text-xs text-muted-foreground capitalize">{details.mode} · {status}</span>
        </span>
        {details.state === 'running' && <LoaderCircleIcon className="size-4 animate-spin text-primary" />}
      </div>
      <div className="space-y-2 p-2.5">
        {details.children.map((child) => <ChildRow key={child.id} child={child} />)}
        {details.children.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">Preparing subagents…</p>
        )}
      </div>
    </section>
  )
})

SubagentRunCard.displayName = 'SubagentRunCard'
