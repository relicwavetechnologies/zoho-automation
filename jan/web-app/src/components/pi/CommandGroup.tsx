import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { resolveToolIdentity, resolveToolLabel } from '@/lib/pi/tool-label'
import { summarizeBurst } from '@/lib/pi/tool-summary'
import { ChevronRightIcon } from 'lucide-react'
import { ToolIcon, resolveToolIconComponent } from './ToolIcon'
import { DotsLoader } from './DotsLoader'
import { isDivoSubagentTool } from '@/lib/pi/subagent'
import { isDivoGatewayApprovalTool } from '@/lib/pi/gateway-approval'

export type CommandGroupTool = {
  part: Record<string, unknown>
  partIndex: number
}

export type CommandGroupProps = {
  messageId: string
  /** Consecutive tool steps that ran back-to-back with no talking between them. */
  tools: CommandGroupTool[]
  /** Streaming and the latest segment → live Running/Ran rows. */
  active: boolean
  /** A tool here is awaiting the user's approval → show its card(s) so the
   * approval controls are visible instead of the compact runner. */
  awaitingApproval: boolean
  renderTool: (part: Record<string, unknown>, partIndex: number) => ReactNode
}

type ToolRunStatus = 'running' | 'done' | 'error'

function toolRunStatus(part: Record<string, unknown>): ToolRunStatus {
  const state = typeof part.state === 'string' ? part.state : ''
  if (state === 'output-error' || state === 'output-denied') return 'error'
  if (state === 'output-available') return 'done'
  return 'running'
}

function commandLabel(part: Record<string, unknown>, fallback: string): string {
  return resolveToolLabel(part) || fallback
}

/**
 * How many distinct tool marks a folded burst shows before it gives up and
 * counts the rest. Four fits the narrow rows without crowding the label.
 */
const ICON_STACK_MAX = 4

/**
 * The distinct tools a folded burst touched, as a row of their own marks.
 *
 * Without this, a collapsed burst reads "Ran 3 commands" and the user has to
 * expand it to learn anything — the marks put Gmail, Lark, or a terminal right
 * on the closed line.
 *
 * This is also what anchors the burst's LEFT edge, the same slot a single row
 * gives to its own tool mark. The log used to lead every folded line with a
 * disclosure arrow, which made the whole timeline a column of chevrons and told
 * the user nothing about what had happened. The mark leads; the chevron trails.
 *
 * Deduped by the RESOLVED ICON, not by tool id: `googleGmail` and a bare
 * `gmail` both draw the Gmail mark, and drawing it twice would imply two
 * different tools. Presence is the signal, not volume — three Gmail calls are
 * still one Gmail mark, because what the row needs to say is "this burst
 * touched Gmail", not how often.
 */
function ToolIconStack({ parts }: { parts: Record<string, unknown>[] }) {
  const icons: ReturnType<typeof resolveToolIconComponent>[] = []
  for (const part of parts) {
    const Icon = resolveToolIconComponent(part)
    if (!icons.includes(Icon)) icons.push(Icon)
  }

  if (icons.length === 0) return null
  const shown = icons.slice(0, ICON_STACK_MAX)
  const overflow = icons.length - shown.length

  return (
    <span
      data-testid="tool-icon-stack"
      className="flex shrink-0 items-center gap-1"
    >
      {shown.map((Icon, i) => (
        <Icon key={i} className="size-3.5 text-muted-foreground/70" />
      ))}
      {overflow > 0 && (
        <span className="text-[11px] text-muted-foreground/50 tabular-nums">
          +{overflow}
        </span>
      )}
    </span>
  )
}

/**
 * The call's headline argument, dimmed beside the label.
 *
 * "Ran web search" tells the user nothing; the query is the whole point. Same
 * for which file a write touched and which command a shell ran. `capitalize` is
 * deliberately NOT applied here — a query, path, or command is verbatim user
 * data and title-casing it would corrupt what it says.
 */
function ToolDetail({ detail }: { detail?: string }) {
  if (!detail) return null
  return (
    <span className="min-w-0 truncate text-[13px] text-muted-foreground/60">
      {detail}
    </span>
  )
}

/**
 * A burst of tool calls.
 *
 * Two shapes, one rule — expanded while it's happening, one line once it isn't:
 *
 *   live    → a header counting up ("Exploring 3 files, ran 1 command") over a
 *             row per call, each shimmering until it lands
 *   settled → a single click-to-expand line with the final tally
 *
 * The rows are never destroyed, only folded, so a finished burst stays fully
 * inspectable without leaving six lines of noise in the thread.
 *
 * A burst of ONE is not a burst. Wrapping a lone call in a "Ran 1 command"
 * summary hid the only thing worth showing — which tool ran — behind a count
 * and a disclosure arrow. A single call renders as its own row instead: its
 * tool mark leads, and the chevron appears on hover at the end.
 *
 * Approval stays an exception: HITL controls must stay visible, so awaiting
 * tools render their real cards instead of the compact rows.
 */
export const CommandGroup = memo(
  ({
    messageId,
    tools,
    active,
    awaitingApproval,
    renderTool,
  }: CommandGroupProps) => {
    const [openIndexes, setOpenIndexes] = useState<Set<number>>(() => new Set())
    const [burstOpen, setBurstOpen] = useState(false)

    if (tools.length === 0) return null

    if (awaitingApproval) {
      return (
        <div className="flex flex-col gap-2">
          {tools.map((t) => (
            <div key={`${messageId}-cmd-${t.partIndex}`}>
              {renderTool(t.part, t.partIndex)}
            </div>
          ))}
        </div>
      )
    }

    const toggle = (partIndex: number) => {
      setOpenIndexes((prev) => {
        const next = new Set(prev)
        if (next.has(partIndex)) next.delete(partIndex)
        else next.add(partIndex)
        return next
      })
    }

    // Subagents have their own live child-run UI, while backend approval
    // statuses carry the result that explains why a company action stopped.
    // Neither should be reduced to a compact command row or folded into a
    // burst tally, so both stay visible in their owning work log.
    const persistentTools = tools.filter(
      (t) => isDivoSubagentTool(t.part) || isDivoGatewayApprovalTool(t.part)
    )
    const commands = tools.filter(
      (t) => !isDivoSubagentTool(t.part) && !isDivoGatewayApprovalTool(t.part)
    )

    // The burst is live while the segment is streaming AND something in it is
    // still in flight. Once everything has landed it folds, even mid-turn.
    const anyRunning = commands.some((t) => toolRunStatus(t.part) === 'running')
    const live = active && anyRunning

    const rows = commands.map((t) => {
      const status = toolRunStatus(t.part)
      const showRunning = active && status === 'running'
      const label = commandLabel(t.part, showRunning ? '…' : 'command')
      const detail = resolveToolIdentity(t.part).detail
      const isOpen = openIndexes.has(t.partIndex)

      if (showRunning) {
        // Running keeps the tool's OWN icon — a running Gmail call should look
        // like Gmail, not like a generic loader. The shimmer on the label
        // carries the "in flight" signal, so the row never changes shape when
        // it settles; only the shimmer and the icon's opacity drop away.
        return (
          <div
            key={`${messageId}-cmd-${t.partIndex}`}
            className="flex items-center gap-2.5 py-0.5 text-sm text-muted-foreground"
          >
            <ToolIcon
              part={t.part}
              className="size-4 shrink-0 text-foreground/80"
            />
            <span className="text-shimmer shrink-0 text-[13px] capitalize">
              {label}
            </span>
            <ToolDetail detail={detail} />
          </div>
        )
      }

      return (
        <div key={`${messageId}-cmd-${t.partIndex}`}>
          <button
            type="button"
            onClick={() => toggle(t.partIndex)}
            className="group flex w-full items-center gap-2.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ToolIcon
              part={t.part}
              className="size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-muted-foreground"
            />
            <span className="shrink-0 text-[13px] capitalize">
              {status === 'error' ? `Failed ${label}` : label}
            </span>
            <ToolDetail detail={detail} />
            <ChevronRightIcon
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-all group-hover:opacity-100',
                isOpen && 'rotate-90 opacity-100'
              )}
            />
          </button>
          {isOpen && (
            <div className="mt-2 mb-1 ml-[26px]">
              {renderTool(t.part, t.partIndex)}
            </div>
          )}
        </div>
      )
    })

    const parts = commands.map((t) => t.part)

    return (
      <div className="flex flex-col gap-1">
        {persistentTools.map((t) => (
          <div key={`${messageId}-cmd-${t.partIndex}`}>
            {renderTool(t.part, t.partIndex)}
          </div>
        ))}

        {/* A lone call speaks for itself — no count, no wrapper, no loader
            header repeating what the row already says. Running, it shimmers
            behind its own mark; settled, it stays click-to-expand. */}
        {commands.length === 1 && rows}

        {commands.length > 1 &&
          (live ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2.5 py-0.5 text-sm">
                <DotsLoader className="text-foreground/80" />
                <span className="text-shimmer truncate text-[13px]">
                  {summarizeBurst(parts, true)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 pl-[26px]">{rows}</div>
            </div>
          ) : (
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => setBurstOpen((v) => !v)}
                className="group flex w-full items-center gap-2.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={burstOpen}
              >
                {/* Leads the row in the same slot a single call gives its own
                    mark, so the log's left edge is a column of tool marks
                    rather than a column of arrows. Kept when open too — the
                    line must not shift sideways as it folds. */}
                <ToolIconStack parts={parts} />
                <span className="shrink-0 text-[13px]">
                  {summarizeBurst(parts, false)}
                </span>
                <ChevronRightIcon
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-all group-hover:opacity-100',
                    burstOpen && 'rotate-90 opacity-100'
                  )}
                />
              </button>
              {burstOpen && (
                <div className="mt-1 mb-1 ml-2 flex flex-col gap-0.5 border-l border-border pl-4">
                  {rows}
                </div>
              )}
            </div>
          ))}
      </div>
    )
  }
)

CommandGroup.displayName = 'CommandGroup'
