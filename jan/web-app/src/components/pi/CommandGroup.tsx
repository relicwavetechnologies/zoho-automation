import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
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
  /** Streaming and the latest segment → show the flip-through-commands runner. */
  active: boolean
  /** A tool here is awaiting the user's approval → show its card(s) so the
   * approval controls are visible instead of the runner. */
  awaitingApproval: boolean
  renderTool: (part: Record<string, unknown>, partIndex: number) => ReactNode
}

/**
 * A burst of tool calls. While it's the running segment it shimmers and rolls
 * through each command as it executes (spinner + rolling name + count); once
 * settled it shows the normal tool card (single) or an expandable "Ran N
 * commands" (many).
 */
export const CommandGroup = memo(
  ({
    messageId,
    tools,
    active,
    awaitingApproval,
    renderTool,
  }: CommandGroupProps) => {
    const [open, setOpen] = useState(false)

    if (tools.length === 0) return null

    // Running: a shimmering pill that rolls each command into view as it runs.
    if (active && !awaitingApproval) {
      const current = tools[tools.length - 1]
      // Show the resolved command the instant it's known; until the tool name /
      // op has streamed in, a muted placeholder keeps the pill from being a bare
      // spinner. It upgrades in place as soon as the op lands.
      const name = resolveToolLabel(current.part) || 'Working…'
      return (
        <div className="relative flex w-fit max-w-[560px] items-center gap-2.5 overflow-hidden rounded-[10px] border bg-secondary/40 px-3 py-2">
          {/* A band of light sweeps across the pill while it works. */}
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-linear-to-r from-transparent via-main-view-fg/10 to-transparent"
            animate={{ left: ['-33%', '133%'] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
          <span className="relative grid place-items-center size-[22px] rounded-md bg-secondary text-muted-foreground shrink-0">
            <Loader2Icon className="size-3.5 animate-spin" />
          </span>
          <div className="relative h-5 flex-1 min-w-0">
            <AnimatePresence initial={false}>
              <motion.div
                key={current.partIndex}
                initial={{ y: 14, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -14, opacity: 0 }}
                transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
                className="absolute inset-0 flex items-center font-mono text-xs text-main-view-fg capitalize truncate"
              >
                {name}
              </motion.div>
            </AnimatePresence>
          </div>
          {tools.length > 1 && (
            <span className="relative shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
              {tools.length}
            </span>
          )}
        </div>
      )
    }

    // Settled single tool → the normal tool card.
    if (tools.length === 1) {
      return <>{renderTool(tools[0].part, tools[0].partIndex)}</>
    }

    // Settled burst → an expandable "Ran N commands" group. Forced open while a
    // tool is awaiting approval so its controls are reachable.
    const isOpen = open || awaitingApproval
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="grid place-items-center size-[22px] rounded-md border bg-secondary text-muted-foreground shrink-0">
            <TerminalIcon className="size-3.5" />
          </span>
          <span>Ran {tools.length} commands</span>
          <ChevronDownIcon
            className={cn(
              'size-4 text-muted-foreground/60 transition-transform',
              isOpen ? 'rotate-180' : 'rotate-0'
            )}
          />
        </button>
        {isOpen && (
          <div className="mt-2 ml-[30px] flex flex-col gap-2">
            {tools.map((t) => (
              <div key={`${messageId}-cmd-${t.partIndex}`}>
                {renderTool(t.part, t.partIndex)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
)

CommandGroup.displayName = 'CommandGroup'
