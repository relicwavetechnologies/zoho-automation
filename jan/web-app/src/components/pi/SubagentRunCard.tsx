import { memo, useMemo, useState } from 'react'
import { BotIcon, ChevronDownIcon } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { cn } from '@/lib/utils'
import { DotsLoader } from './DotsLoader'
import { SubagentMark } from './SubagentMark'
import { ToolIcon } from './ToolIcon'
import { describeSubagentEvent, summarizeSubagentTask } from '@/lib/pi/subagent-event'
import {
  readDivoSubagentDetails,
  type DivoSubagentChild,
  type DivoSubagentEvent,
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

/**
 * The settled state, as a dot.
 *
 * A green check on every finished child made success the loudest thing in the
 * card — four ticks shouting about work the user never doubted, and drowning
 * the one row that actually needed attention. Completion is the expected
 * outcome, so it earns a quiet neutral dot; only failure keeps a colour, and
 * it now reads as the single exception rather than one tick among four.
 */
function StateDot({ state, className }: { state: DivoSubagentState; className?: string }) {
  const failed = state === 'failed' || state === 'cancelled'
  return (
    <span
      data-testid="subagent-state-dot"
      data-state={state}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        failed ? 'bg-destructive' : 'bg-muted-foreground/50',
        className
      )}
    />
  )
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
 * One step in a child's log.
 *
 * A tool step borrows the parent work log's whole vocabulary — the vendor mark,
 * the humanised label, the dimmed headline argument — so a Gmail call reads the
 * same one level down as it does at the top. Anything else is a lifecycle note
 * and stays plain text.
 */
const EventRow = memo(({ event }: { event: DivoSubagentEvent }) => {
  const view = describeSubagentEvent(event)

  return (
    <li className="flex gap-2">
      <span className="w-8 shrink-0 font-mono text-[10px] leading-5 text-muted-foreground/65">
        #{event.seq}
      </span>
      {view.kind === 'tool' ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 leading-5">
          <ToolIcon part={view.part} className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="shrink-0 capitalize">{view.identity.label}</span>
          {view.identity.detail && (
            <span className="min-w-0 truncate text-muted-foreground/60">
              {view.identity.detail}
            </span>
          )}
        </span>
      ) : (
        <span className="min-w-0 flex-1 leading-5">{view.text}</span>
      )}
    </li>
  )
})

EventRow.displayName = 'SubagentRunCardEvent'

/**
 * A child's report, rendered as the markdown it is.
 *
 * Agents write their findings in markdown — headings, numbered lists, bold
 * names, backticked emails. A `<pre>` showed all of that as source, so the one
 * genuinely valuable payload in the card was also the only text in the app the
 * user had to mentally un-escape. It gets the same renderer as the main answer.
 *
 * An error is the exception and stays monospaced: it is usually a stack or a
 * wire payload, where markdown would mangle the very characters that matter.
 */
const ChildOutput = memo(({ text, isError }: { text: string; isError: boolean }) => {
  if (isError) {
    return (
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/55 p-2 font-mono text-[11px] leading-relaxed text-destructive">
        {text}
      </pre>
    )
  }

  return (
    <div
      dir="auto"
      className={cn(
        'mt-2 max-h-72 overflow-auto rounded bg-muted/55 p-2.5 text-[13px] leading-relaxed text-muted-foreground',
        // The report is a nested, secondary voice inside a log row, so its
        // headings must not out-shout the child's own name above it. Everything
        // collapses toward body weight; structure survives through spacing.
        '[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px]',
        '[&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium',
        '[&_h1]:text-foreground/90 [&_h2]:text-foreground/90 [&_h3]:text-foreground/90',
        '[&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0',
        '[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5',
        '[&_strong]:font-medium [&_strong]:text-foreground/90',
        '[&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]',
        '[&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background/60 [&_pre]:p-2',
        '[&_a]:underline [&_a]:underline-offset-2',
        '[&_table]:my-1 [&_table]:block [&_table]:overflow-x-auto [&_th]:px-2 [&_th]:text-left [&_td]:px-2'
      )}
    >
      <Streamdown>{text}</Streamdown>
    </div>
  )
})

ChildOutput.displayName = 'SubagentRunCardOutput'

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
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          {running ? (
            // Scatter, not wave: a child run is a whole agent working, and
            // several of these sit stacked. The busier rhythm keeps the group
            // reading as live rather than as a static list of labels.
            <DotsLoader variant="scatter" className="text-foreground/80" />
          ) : (
            <StateDot state={child.state} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          {/* Role and model, mirroring Cursor's "name · model" head line, with
              the agent's own mark leading it. The mark sits HERE rather than in
              the status slot on the left, because that slot belongs to the
              run's state — it has to stay free for the loader while the child
              works. Identity and progress are two different questions, so they
              get two different places to answer from. */}
          <span className="flex items-center gap-1.5">
            <SubagentMark
              seed={child.role || child.id}
              className={cn('size-3.5 shrink-0', !running && 'opacity-70')}
            />
            <span className={cn('text-sm capitalize', running ? 'text-foreground' : 'text-muted-foreground')}>
              {child.role}
            </span>
            {child.model && <span className="truncate text-[13px] text-muted-foreground/70">{child.model}</span>}
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground/70">
            {summarizeSubagentTask(child.task)}
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
                <EventRow key={`${child.id}-${event.seq}`} event={event} />
              ))}
            </ol>
          )}
          {output && <ChildOutput text={output} isError={Boolean(child.error)} />}
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
