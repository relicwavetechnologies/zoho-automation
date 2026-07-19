import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { resolveToolLabel } from '@/lib/pi/tool-label'
import { ChevronDownIcon } from 'lucide-react'
import { ToolIcon } from './ToolIcon'
import { isDivoSubagentTool } from '@/lib/pi/subagent'

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
 * A burst of tool calls. Each command gets its own row:
 *   Running {label}  — while that call is in flight
 *   Ran {label}      — once it finishes (expandable to the full tool card)
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

    return (
      <div className="flex flex-col gap-1.5">
        {tools.map((t) => {
          // A subagent tool has its own live child-run UI. Rendering it as a
          // compact generic command row would hide progress until completion.
          if (isDivoSubagentTool(t.part)) {
            return (
              <div key={`${messageId}-cmd-${t.partIndex}`}>
                {renderTool(t.part, t.partIndex)}
              </div>
            )
          }

          const status = toolRunStatus(t.part)
          const running = status === 'running'
          // While the burst is live, unfinished calls say Running; finished
          // ones flip to Ran in place. After the segment settles, everything
          // is Ran (or failed) — including calls that never got a terminal
          // state streamed (treat as done for display once inactive).
          const showRunning = active && running
          const label = commandLabel(
            t.part,
            showRunning ? '…' : 'command'
          )
          const isOpen = openIndexes.has(t.partIndex)
          const canExpand = !showRunning

          return (
            <div key={`${messageId}-cmd-${t.partIndex}`}>
              {canExpand ? (
                <button
                  type="button"
                  onClick={() => toggle(t.partIndex)}
                  className="group flex items-center gap-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ToolIcon
                    part={t.part}
                    className="size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-muted-foreground"
                  />
                  <span className="text-[13px] capitalize truncate">
                    {status === 'error' ? `Failed ${label}` : `Ran ${label}`}
                  </span>
                  <ChevronDownIcon
                    className={cn(
                      'size-4 text-muted-foreground/60 transition-transform shrink-0',
                      isOpen ? 'rotate-180' : 'rotate-0'
                    )}
                  />
                </button>
              ) : (
                // Running rows keep the tool's own icon and shimmer the label,
                // so the row doesn't change shape when it settles into "Ran".
                <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                  <ToolIcon
                    part={t.part}
                    className="size-4 shrink-0 text-muted-foreground/70"
                  />
                  <span className="text-shimmer text-[13px] capitalize truncate">
                    Running {label}
                  </span>
                </div>
              )}
              {canExpand && isOpen && (
                <div className="mt-2 ml-[26px]">
                  {renderTool(t.part, t.partIndex)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }
)

CommandGroup.displayName = 'CommandGroup'
