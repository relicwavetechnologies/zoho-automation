import { memo } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  toolStatusLabel,
} from '@/components/ai-elements/chain-of-thought'
import { cn } from '@/lib/utils'
import { LightbulbIcon } from 'lucide-react'
import { Streamdown } from 'streamdown'
import type { PiTraceStep } from '@/lib/pi/split-trace-parts'

export type PiTraceTimelineProps = {
  messageId: string
  steps: PiTraceStep[]
  isStreaming: boolean
  hasPendingToolCall: boolean
  awaitingApproval: boolean
  renderTool: (part: Record<string, unknown>, partIndex: number) => ReactNode
  reasoningContainerRef?: RefObject<HTMLDivElement | null>
  isReasoningAtBottom?: boolean
  onReasoningScroll?: () => void
  onReasoningScrollToBottom?: () => void
}

export const PiTraceTimeline = memo(
  ({
    messageId,
    steps,
    isStreaming,
    awaitingApproval,
    renderTool,
    reasoningContainerRef,
    isReasoningAtBottom,
    onReasoningScroll,
    onReasoningScrollToBottom,
  }: PiTraceTimelineProps) => {
    const hasTools = steps.some((s) => s.kind === 'tool')
    const lastStep = steps[steps.length - 1]
    // The trace is "active" for the whole time the message streams. Keeping this
    // stable (rather than toggling per tool/reasoning step) is what stops the
    // header label from flickering between the roller and "Worked for N".
    const traceIsActive = isStreaming

    const currentStepIsTool = lastStep?.kind === 'tool'

    // Only force the panel open when a tool is genuinely awaiting the user's
    // approval — its buttons must be visible. A normally-executing tool must NOT
    // force it open, or the trace flickers open/closed on every tool step.
    const keepOpen = awaitingApproval

    // Live status shown in the collapsed header while the trace streams.
    const statusLabel = awaitingApproval
      ? 'Waiting for approval…'
      : currentStepIsTool
        ? toolStatusLabel(String((lastStep.part as { type?: string })?.type ?? ''))
        : 'Thinking…'

    if (steps.length === 0) return null

    return (
      <ChainOfThought
        key={`${messageId}-pi-trace`}
        className="w-full text-muted-foreground mb-3"
        isStreaming={traceIsActive}
        shouldCollapse={traceIsActive && !keepOpen}
        forceOpen={keepOpen}
        defaultOpen={false}
        data-testid="pi-trace"
      >
        <ChainOfThoughtHeader
          statusLabel={statusLabel}
          streamingLabel={
            awaitingApproval
              ? 'Waiting for approval...'
              : currentStepIsTool ? 'Using tools...' : 'Reasoning...'
          }
          completedVerb={hasTools ? 'Worked' : 'Thought'}
        />
        <ChainOfThoughtContent>
          <ol className="flex flex-col gap-3 list-none p-0 m-0">
            {steps.map((step) => {
              if (step.kind === 'tool') {
                return (
                  <li
                    key={`${messageId}-tool-${step.partIndex}`}
                    className="min-w-0"
                  >
                    {renderTool(step.part, step.partIndex)}
                  </li>
                )
              }

              const isThought = step.kind === 'thought'
              const isActiveThought =
                isThought &&
                isStreaming &&
                step.state === 'streaming'

              const text = step.text

              if (!text.trim() && !isActiveThought) return null

              return (
                <li
                  key={`${messageId}-${step.kind}-${step.partIndex}`}
                  className="min-w-0"
                >
                  <div className="flex gap-2.5 items-start">
                    <span className="mt-0.5 shrink-0 text-muted-foreground/60">
                      {isThought ? (
                        <LightbulbIcon className="size-3.5" />
                      ) : (
                        <span className="block size-1.5 mt-1.5 ml-1 rounded-full bg-muted-foreground/40" />
                      )}
                    </span>
                    <div
                      ref={isActiveThought ? reasoningContainerRef : undefined}
                      onScroll={isActiveThought ? onReasoningScroll : undefined}
                      className={cn(
                        'flex-1 min-w-0 max-w-[70ch] select-text text-sm leading-relaxed text-main-view-fg/70',
                        isActiveThought &&
                          'max-h-64 overflow-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden'
                      )}
                    >
                      {isActiveThought ? (
                        <div className="whitespace-pre-wrap wrap-break-word">
                          {text}
                        </div>
                      ) : (
                        <Streamdown>{text}</Streamdown>
                      )}
                      {isActiveThought && !isReasoningAtBottom && onReasoningScrollToBottom && (
                        <button
                          type="button"
                          className="mt-2 block text-xs text-muted-foreground hover:text-foreground"
                          onClick={onReasoningScrollToBottom}
                        >
                          Scroll to latest
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        </ChainOfThoughtContent>
      </ChainOfThought>
    )
  }
)

PiTraceTimeline.displayName = 'PiTraceTimeline'
