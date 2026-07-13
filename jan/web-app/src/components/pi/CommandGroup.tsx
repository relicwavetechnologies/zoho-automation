import { memo, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
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

const toolName = (type: string): string =>
  type.split('-').slice(1).join('-').replaceAll('_', ' ') || 'tool'

/**
 * A burst of tool calls. While it's the running segment it flips through each
 * command as it executes (spinner + split-flap name + count); once settled it
 * shows the normal tool card (single) or an expandable "Ran N commands" (many).
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

    // Running: flip through the commands as they execute.
    if (active && !awaitingApproval) {
      const current = tools[tools.length - 1]
      const name = toolName(String(current.part?.type ?? ''))
      return (
        <div className="flex items-center gap-2.5 max-w-[560px] rounded-[10px] border bg-secondary/40 px-3 py-2">
          <span className="grid place-items-center size-[22px] rounded-md bg-secondary text-muted-foreground shrink-0">
            <Loader2Icon className="size-3.5 animate-spin" />
          </span>
          <div className="relative h-5 flex-1 min-w-0 [perspective:500px]">
            <AnimatePresence>
              <motion.div
                key={current.partIndex}
                initial={{ rotateX: -90, opacity: 0 }}
                animate={{ rotateX: 0, opacity: 1 }}
                exit={{ rotateX: 90, opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.3, 0.7, 0.4, 1] }}
                className="absolute inset-0 flex items-center font-mono text-xs text-main-view-fg capitalize truncate [transform-origin:center_bottom] [backface-visibility:hidden]"
              >
                {name}
              </motion.div>
            </AnimatePresence>
          </div>
          {tools.length > 1 && (
            <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
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
