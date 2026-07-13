import { memo } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import { CommandGroup } from './CommandGroup'
import type { CommandGroupTool } from './CommandGroup'
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

type TalkStep = Extract<PiTraceStep, { kind: 'thought' | 'narration' }>
type Segment =
  | { kind: 'talk'; step: TalkStep }
  | { kind: 'tools'; tools: CommandGroupTool[] }

export const PiTraceTimeline = memo(
  ({
    messageId,
    steps,
    isStreaming,
    awaitingApproval,
    renderTool,
  }: PiTraceTimelineProps) => {
    const hasTools = steps.some((s) => s.kind === 'tool')

    // While the turn streams, keep the trace open and show the model's talking
    // (narration) and tool runs live — the deep reasoning stays folded and is
    // only revealed when the completed trace is expanded. Once the turn finishes
    // the whole thing collapses into "Worked for N seconds".
    const liveMode = isStreaming
    const keepOpen = awaitingApproval

    if (steps.length === 0) return null

    // Hide reasoning while streaming; show everything (incl. reasoning) once the
    // trace is a completed, expandable "Worked for N seconds" block.
    const visibleSteps = liveMode
      ? steps.filter((s) => s.kind !== 'thought')
      : steps

    // Coalesce consecutive tool steps into one command group; keep talking
    // (narration while live, + reasoning once settled) as its own segment.
    const segments: Segment[] = []
    for (const step of visibleSteps) {
      if (step.kind === 'tool') {
        const last = segments[segments.length - 1]
        if (last && last.kind === 'tools') {
          last.tools.push({ part: step.part, partIndex: step.partIndex })
        } else {
          segments.push({
            kind: 'tools',
            tools: [{ part: step.part, partIndex: step.partIndex }],
          })
        }
      } else if (step.text.trim()) {
        segments.push({ kind: 'talk', step })
      }
    }

    const lastSegmentIndex = segments.length - 1

    return (
      <ChainOfThought
        key={`${messageId}-pi-trace`}
        className="w-full text-muted-foreground mb-3"
        isStreaming={isStreaming}
        shouldCollapse={!isStreaming && !keepOpen}
        forceOpen={keepOpen}
        defaultOpen={isStreaming}
        data-testid="pi-trace"
      >
        <ChainOfThoughtHeader
          streamingLabel={awaitingApproval ? 'Waiting for approval...' : 'Working...'}
          completedVerb={hasTools ? 'Worked' : 'Thought'}
        />
        {segments.length > 0 && (
          <ChainOfThoughtContent>
            <div className="flex flex-col gap-3.5">
              {segments.map((seg, i) => {
                if (seg.kind === 'tools') {
                  return (
                    <CommandGroup
                      key={`${messageId}-cmds-${seg.tools[0].partIndex}`}
                      messageId={messageId}
                      tools={seg.tools}
                      active={isStreaming && i === lastSegmentIndex}
                      awaitingApproval={
                        awaitingApproval && i === lastSegmentIndex
                      }
                      renderTool={renderTool}
                    />
                  )
                }

                const step = seg.step
                // Reasoning (thought): muted, marked with a bulb — secondary
                // detail shown only when the completed trace is expanded.
                if (step.kind === 'thought') {
                  return (
                    <div
                      key={`${messageId}-thought-${step.partIndex}`}
                      className="flex gap-2.5 items-start min-w-0"
                    >
                      <LightbulbIcon className="size-3.5 mt-1 shrink-0 text-muted-foreground/60" />
                      <div className="flex-1 min-w-0 max-w-[70ch] select-text text-sm leading-relaxed text-main-view-fg/70">
                        <Streamdown>{step.text}</Streamdown>
                      </div>
                    </div>
                  )
                }

                // Narration = the model's talking. Full foreground, like a real
                // message — this is active work, not idle thinking.
                return (
                  <div
                    key={`${messageId}-narration-${step.partIndex}`}
                    className="min-w-0 max-w-[72ch] select-text text-[15px] leading-relaxed text-main-view-fg"
                  >
                    <Streamdown>{step.text}</Streamdown>
                  </div>
                )
              })}
            </div>
          </ChainOfThoughtContent>
        )}
      </ChainOfThought>
    )
  }
)

PiTraceTimeline.displayName = 'PiTraceTimeline'
