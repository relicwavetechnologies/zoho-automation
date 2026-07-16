import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { resolveToolLabel } from '@/lib/pi/tool-label'
import { TerminalIcon, Loader2Icon, ChevronDownIcon } from 'lucide-react'

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
                  className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span className="grid place-items-center size-[22px] rounded-md border bg-secondary text-muted-foreground shrink-0">
                    <TerminalIcon className="size-3.5" />
                  </span>
                  <span className="font-mono text-xs capitalize truncate">
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
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="grid place-items-center size-[22px] rounded-md bg-secondary text-muted-foreground shrink-0">
                    <Loader2Icon className="size-3.5 animate-spin" />
                  </span>
                  <span className="font-mono text-xs capitalize truncate">
                    Running {label}
                  </span>
                </div>
              )}
              {canExpand && isOpen && (
                <div className="mt-2 ml-[30px]">
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
