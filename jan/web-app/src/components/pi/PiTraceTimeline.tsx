import { memo } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import { cn } from '@/lib/utils'
import { SparklesIcon } from 'lucide-react'
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
    hasPendingToolCall,
    awaitingApproval,
    renderTool,
    reasoningContainerRef,
    isReasoningAtBottom,
    onReasoningScroll,
    onReasoningScrollToBottom,
  }: PiTraceTimelineProps) => {
    const hasTools = steps.some((s) => s.kind === 'tool')
    const lastStep = steps[steps.length - 1]
    const lastPartIndex = lastStep?.partIndex ?? -1
    const traceIsActive =
      isStreaming &&
      (lastStep?.kind === 'tool'
        ? hasPendingToolCall
        : lastPartIndex >= 0)

    const currentStepIsTool =
      lastStep?.kind === 'tool' && hasPendingToolCall

    if (steps.length === 0) return null

    return (
      <ChainOfThought
        key={`${messageId}-pi-trace`}
        className="w-full text-muted-foreground mb-3"
        isStreaming={traceIsActive}
        shouldCollapse={false}
        forceOpen
        defaultOpen
        data-testid="pi-trace"
      >
        <ChainOfThoughtHeader
          streamingLabel={
            currentStepIsTool ? 'Using tools...' : 'Reasoning...'
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
                  <div className="flex gap-2 items-start">
                    {isThought && (
                      <SparklesIcon className="size-3.5 mt-1 shrink-0 opacity-50" />
                    )}
                    <div
                      ref={isActiveThought ? reasoningContainerRef : undefined}
                      onScroll={isActiveThought ? onReasoningScroll : undefined}
                      className={cn(
                        'flex-1 min-w-0 select-text whitespace-pre-wrap wrap-break-word text-sm text-main-view-fg/70',
                        isActiveThought &&
                          'max-h-64 overflow-auto opacity-80 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
                        step.kind === 'narration' && 'opacity-85'
                      )}
                    >
                      {text}
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
