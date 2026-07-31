import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRightIcon, WaypointsIcon } from 'lucide-react'
import {
  ChainOfThought,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import { CollapsibleContent } from '@/components/ui/collapsible'
import { DivoDexMark } from '@/components/DivoDexBrand'
import { CommandGroup } from './CommandGroup'
import type { CommandGroupTool } from './CommandGroup'
import { Streamdown } from 'streamdown'
import { cn } from '@/lib/utils'
import type { PiTraceStep } from '@/lib/pi/split-trace-parts'
import { isDivoGatewayApprovalTool } from '@/lib/pi/gateway-approval'

/** Distance from bottom (px) at which we keep auto-following the live head. */
const STICK_BOTTOM_THRESHOLD_PX = 48

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

function coalesceSegments(steps: PiTraceStep[]): Segment[] {
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
  return segments
}

/**
 * Reasoning, in its two states.
 *
 * While it streams it gets a short fixed-height window that scrolls itself and
 * fades at the top — you can watch the model think without the page growing
 * under you. The moment it settles it folds to a single "Thought" line and the
 * narration it produced takes over the flow.
 *
 * That ordering is the whole point of the redesign: thinking and talking used
 * to render at the same weight, so a turn read as one undifferentiated wall.
 * Here the thought is the receipt and the narration is the content.
 */
const ThoughtStep = memo(
  ({ text, live }: { text: string; live: boolean }) => {
    const [open, setOpen] = useState(false)
    const windowRef = useRef<HTMLDivElement>(null)

    // Pin the live window to its own bottom so the newest sentence shows.
    useLayoutEffect(() => {
      if (!live) return
      const el = windowRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, [live, text])

    if (live) {
      return (
        <div
          ref={windowRef}
          data-testid="pi-thought-live"
          dir="auto"
          className={cn(
            'max-h-[68px] max-w-[70ch] overflow-y-hidden text-[13px] leading-relaxed text-muted-foreground/85',
            // Fade the outgoing top edge so lines dissolve rather than clip.
            '[mask-image:linear-gradient(to_bottom,transparent_0,#000_26px,#000_100%)]'
          )}
        >
          <Streamdown>{text}</Streamdown>
        </div>
      )
    }

    return (
      <div className="flex flex-col">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="group flex w-full items-center gap-2.5 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {/* Reasoning gets a mark in the same leading slot the tool rows use.
              A settled thought is a step like any other, and leading it with a
              bare arrow made every folded line in the log start with a chevron
              — structure the eye has to decode instead of read. */}
          {/* Branching nodes, not a brain: at 16px the brain is a blot of path
              beside the magnifier and terminal marks below it, and a lightbulb
              reads "idea" rather than "thinking". This one is symmetric, so it
              centres cleanly in the same leading column as the tool marks.
              Thinner than the lucide default to match their optical weight. */}
          <WaypointsIcon
            strokeWidth={1.5}
            className="size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-muted-foreground"
          />
          <span className="text-[13px]">Thought</span>
          <ChevronRightIcon
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-all group-hover:opacity-100',
              open && 'rotate-90 opacity-100'
            )}
          />
        </button>
        {open && (
          <div
            dir="auto"
            className="my-1 ml-2 max-w-[70ch] border-l border-border pl-4 text-[13px] leading-relaxed text-muted-foreground/80"
          >
            <Streamdown>{text}</Streamdown>
          </div>
        )}
      </div>
    )
  }
)

ThoughtStep.displayName = 'PiTraceThoughtStep'

/**
 * The agent's working trace.
 *
 * Everything here follows one rule: a step is expanded while it is happening
 * and compacts to a single expandable line once it is not. Reasoning folds to
 * "Thought", a burst of tool calls folds to "Explored 8 files, ran 4 commands",
 * and when the turn ends the whole log folds to "Worked for 56s" with the
 * answer below it. Narration is the exception — it is content, not metadata, so
 * it stays at full weight.
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
    const scrollRef = useRef<HTMLDivElement>(null)
    const stickToBottomRef = useRef(true)
    const segments = coalesceSegments(steps)
    const hasBackendApproval = steps.some(
      (step) => step.kind === 'tool' && isDivoGatewayApprovalTool(step.part)
    )
    const keepOpen = awaitingApproval || hasBackendApproval
    const shouldFollow = isStreaming || keepOpen

    // Keep the live head in view while working, unless the user scrolled up.
    // Local approval resets that choice so its controls remain reachable;
    // backend approval status only keeps its completed trace open.
    useLayoutEffect(() => {
      const el = scrollRef.current
      if (!el || !shouldFollow) return
      if (awaitingApproval) stickToBottomRef.current = true
      if (!stickToBottomRef.current) return
      el.scrollTop = el.scrollHeight
    }, [shouldFollow, awaitingApproval, segments, steps])

    if (segments.length === 0) return null

    const hasTools = steps.some((s) => s.kind === 'tool')
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
          streamingLabel={awaitingApproval ? 'Waiting for approval' : 'Working'}
          completedVerb={hasTools ? 'Worked' : 'Thought'}
          // Divo's own mark rather than a generic sparkle — this row is the
          // product reporting on itself.
          icon={<DivoDexMark decorative className="size-4 shrink-0 opacity-70" />}
        />
        <CollapsibleContent
          className={cn(
            'mt-2 text-sm outline-none',
            'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in'
          )}
        >
          <div
            ref={scrollRef}
            data-testid="pi-trace-scroll"
            onScroll={() => {
              const el = scrollRef.current
              if (!el) return
              const distanceFromBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight
              stickToBottomRef.current =
                distanceFromBottom <= STICK_BOTTOM_THRESHOLD_PX
            }}
            className={cn(
              'overflow-x-hidden',
              // The log no longer needs a hard height cap: settled steps fold
              // themselves, so it can sit inline and grow with the thread the
              // way the rest of the message does. Approval is the exception —
              // its controls are tall, so that one gets a scrolling window.
              awaitingApproval &&
                'max-h-[min(50vh,28rem)] overflow-y-auto pr-1 [scrollbar-gutter:stable]'
            )}
          >
            <TimelineBody
              messageId={messageId}
              segments={segments}
              lastSegmentIndex={lastSegmentIndex}
              isStreaming={isStreaming}
              awaitingApproval={awaitingApproval}
              renderTool={renderTool}
              renderNarration={renderNarration}
            />
          </div>
        </CollapsibleContent>
      </ChainOfThought>
    )
  }
)

type TimelineBodyProps = {
  messageId: string
  segments: Segment[]
  lastSegmentIndex: number
  isStreaming: boolean
  awaitingApproval: boolean
  renderTool: PiTraceTimelineProps['renderTool']
  renderNarration: PiTraceTimelineProps['renderNarration']
}

const TimelineBody = memo(
  ({
    messageId,
    segments,
    lastSegmentIndex,
    isStreaming,
    awaitingApproval,
    renderTool,
    renderNarration,
  }: TimelineBodyProps) => (
    // Flat and inline — no rail, no nodes. Structure comes from the fold state
    // of each step and from the weight difference between narration and meta.
    <div className="flex w-full flex-col gap-1.5">
      {segments.map((seg, i) => {
        const active = isStreaming && i === lastSegmentIndex
        return (
          <div
            key={
              seg.kind === 'tools'
                ? `${messageId}-cmds-${seg.tools[0].partIndex}`
                : `${messageId}-talk-${seg.step.partIndex}`
            }
            className="min-w-0"
          >
            {seg.kind === 'tools' ? (
              <CommandGroup
                messageId={messageId}
                tools={seg.tools}
                active={active}
                awaitingApproval={awaitingApproval && i === lastSegmentIndex}
                renderTool={renderTool}
              />
            ) : seg.step.kind === 'thought' ? (
              <ThoughtStep text={seg.step.text} live={active} />
            ) : (
              // Narration: rendered exactly like the final answer.
              <div className="py-1">
                {renderNarration(seg.step.text, seg.step.partIndex)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
)

TimelineBody.displayName = 'PiTraceTimelineBody'
PiTraceTimeline.displayName = 'PiTraceTimeline'
