import { memo } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import {
  ChainOfThought,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import { CollapsibleContent } from '@/components/ui/collapsible'
import { CommandGroup } from './CommandGroup'
import type { CommandGroupTool } from './CommandGroup'
import { Streamdown } from 'streamdown'
import { cn } from '@/lib/utils'
import type { PiTraceStep } from '@/lib/pi/split-trace-parts'

export type PiTraceTimelineProps = {
  messageId: string
  steps: PiTraceStep[]
  isStreaming: boolean
  awaitingApproval: boolean
  renderTool: (part: Record<string, unknown>, partIndex: number) => ReactNode
  /**
   * Renders a narration text step with the SAME markdown renderer as the final
   * answer, so the model's talking reads as normal prose. Supplied by the
   * message container.
   */
  renderNarration: (text: string, partIndex: number) => ReactNode
}

type TalkStep = Extract<PiTraceStep, { kind: 'thought' | 'narration' }>
type Segment =
  | { kind: 'talk'; step: TalkStep }
  | { kind: 'tools'; tools: CommandGroupTool[] }

/**
 * The agent's working trace, rendered as a live vertical timeline.
 *
 * While the turn streams the timeline is open: reasoning, narration, and tool
 * runs sit on a rail with a beam of light travelling down it, the current step
 * pulsing at the head. When the turn finishes the whole thing wraps up into a
 * single "Worked for N seconds" line (re-expandable to the static timeline).
 * The deliverable answer renders below, outside the trace.
 */
export const PiTraceTimeline = memo(
  ({
    messageId,
    steps,
    isStreaming,
    awaitingApproval,
    renderTool,
    renderNarration,
  }: PiTraceTimelineProps) => {
    if (steps.length === 0) return null

    const hasTools = steps.some((s) => s.kind === 'tool')

    // Coalesce consecutive tool steps into one command group; talking
    // (reasoning + narration) stays as its own segment in reading order.
    const segments: Segment[] = []
    for (const step of steps) {
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

    if (segments.length === 0) return null

    const lastSegmentIndex = segments.length - 1
    const keepOpen = awaitingApproval

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
        <CollapsibleContent
          className={cn(
            'mt-3 text-sm outline-none',
            'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in'
          )}
        >
          <div className="relative flex w-full flex-col gap-3.5">
            {/* The rail — a hairline the whole timeline hangs from, centered at
                x=6px. Nodes are opaque and centered on the same axis so each one
                caps the rail cleanly. While the turn streams, a beam of light
                travels down it end to end. */}
            <div className="pointer-events-none absolute left-[6px] top-2.5 bottom-2.5 w-px -translate-x-1/2 overflow-hidden bg-border">
              {isStreaming && (
                <motion.div
                  className="absolute inset-x-[-1px] h-10 bg-linear-to-b from-transparent via-primary to-transparent"
                  initial={{ top: '-14%' }}
                  animate={{ top: ['-14%', '114%'] }}
                  transition={{
                    duration: 1.7,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                />
              )}
            </div>

            {segments.map((seg, i) => {
              const active = isStreaming && i === lastSegmentIndex
              return (
                <div
                  key={
                    seg.kind === 'tools'
                      ? `${messageId}-cmds-${seg.tools[0].partIndex}`
                      : `${messageId}-talk-${seg.step.partIndex}`
                  }
                  className="relative flex gap-3"
                >
                  {/* Timeline node. The head pulses while it's the live step;
                      settled steps are quiet filled dots. */}
                  <div className="relative w-3 shrink-0">
                    <span
                      className={cn(
                        'absolute left-1/2 top-1.5 -translate-x-1/2 rounded-full transition-colors',
                        active
                          ? 'size-2.5 bg-primary ring-[3px] ring-primary/20'
                          : 'size-2 bg-muted-foreground'
                      )}
                    />
                    {active && (
                      <span className="absolute left-1/2 top-1.5 size-2.5 -translate-x-1/2 rounded-full bg-primary/30 animate-ping" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    {seg.kind === 'tools' ? (
                      <CommandGroup
                        messageId={messageId}
                        tools={seg.tools}
                        active={active}
                        awaitingApproval={
                          awaitingApproval && i === lastSegmentIndex
                        }
                        renderTool={renderTool}
                      />
                    ) : seg.step.kind === 'thought' ? (
                      // Reasoning: the model's thinking. Same prose, dimmed.
                      <div
                        dir="auto"
                        className="min-w-0 max-w-[72ch] select-text text-sm leading-relaxed text-main-view-fg/55"
                      >
                        <Streamdown>{seg.step.text}</Streamdown>
                      </div>
                    ) : (
                      // Narration: rendered exactly like the final answer.
                      renderNarration(seg.step.text, seg.step.partIndex)
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CollapsibleContent>
      </ChainOfThought>
    )
  }
)

PiTraceTimeline.displayName = 'PiTraceTimeline'
