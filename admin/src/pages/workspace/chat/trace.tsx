/**
 * The agent's working trace, ported from the desktop's `PiTraceTimeline`.
 *
 * Everything here follows one rule: **a step is expanded while it is happening
 * and compacts to a single expandable line once it is not.** Reasoning folds to
 * "Thought", a run of tool calls folds to "Searched Zoho Books", and when the
 * turn ends the whole log folds to "Worked for 39.6s" with the answer below it.
 * Narration is the exception — it is content, not metadata, so it stays at full
 * weight and reads like prose.
 *
 * Flat and inline: no rail, no nodes, no nesting. Structure comes from the fold
 * state of each step and from the weight difference between narration and the
 * rest. An earlier attempt here put the burst inside the log's own fold, so
 * reading one tool call meant opening two disclosures — that is the shape this
 * file exists to not have.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Waypoints } from 'lucide-react'
import { ToolMark } from './tools'
import { AgentRunView } from './agents.view'
import { burstMarks, summarizeBurst } from './burst'
import { DivoMark, DotsLoader, PixelGrid, Shimmer } from './loader'
import { Markdown, Step } from './parts'
import { coalesceSegments, type TraceSegment, type TraceStep } from './lifecycle'
import { elapsedLabel } from './player'

/* ── Thought ──────────────────────────────────────────────
   Reasoning, in its two states.

   While it streams it gets a short fixed-height window that scrolls itself and
   fades at the top — you can watch the model think without the page growing
   under you. The moment it settles it folds to a single "Thought" line and the
   narration it produced takes over the flow.

   That ordering is the whole point: thinking and talking used to render at the
   same weight, so a turn read as one undifferentiated wall. Here the thought is
   the receipt and the narration is the content. */
function ThoughtStep({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  const windowRef = useRef<HTMLDivElement>(null)

  // Pin the live window to its own bottom so the newest sentence shows.
  useLayoutEffect(() => {
    if (!live) return
    const node = windowRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [live, text])

  if (live) {
    return (
      <div
        ref={windowRef}
        className="max-h-[68px] max-w-[70ch] overflow-y-hidden text-[13px] leading-relaxed text-ink-3"
        // The outgoing top edge dissolves rather than clipping, so a line
        // leaving the window reads as scrolled past instead of cut off.
        style={{ maskImage: 'linear-gradient(to bottom, transparent 0, #000 26px, #000 100%)' }}
      >
        {text}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2.5 py-0.5 text-left text-[13px] text-ink-2 transition-colors duration-100 hover:text-ink"
      >
        {/* Reasoning gets a mark in the same leading slot the tool rows use. A
            settled thought is a step like any other, and leading it with a bare
            arrow made every folded line in the log start with a chevron —
            structure the eye has to decode instead of read.

            Branching nodes, not a brain: at this size a brain is a blot beside
            the vendor marks below it, and a lightbulb reads "idea" rather than
            "thinking". This one is symmetric, so it centres cleanly in the same
            leading column. Thinner than the lucide default to match the optical
            weight of the marks. */}
        <Waypoints size={14} strokeWidth={1.5} className="shrink-0 text-ink-3" />
        <span className="shrink-0">Thought</span>
        <ChevronRight
          size={13}
          className={`shrink-0 text-ink-3 opacity-0 transition-all duration-150 group-hover:opacity-100 ${open ? 'rotate-90 opacity-100' : ''}`}
        />
      </button>
      {open && (
        <div className="my-1 ml-2 max-w-[70ch] border-l border-line pl-4 text-[13px] leading-relaxed text-ink-3">
          {text}
        </div>
      )}
    </div>
  )
}

/* ── CommandGroup ─────────────────────────────────────────
   A burst of tool calls, in two shapes and one rule — expanded while it is
   happening, one line once it is not.

   A burst of ONE is not a burst. Wrapping a lone call in a "Ran 1 command"
   summary hides the only thing worth showing — which tool ran — behind a count
   and a disclosure arrow. A single call renders as its own row instead: its
   mark leads, and the chevron appears on hover at the end. */
function CommandGroup({
  steps, streaming,
}: {
  steps: Extract<TraceStep, { kind: 'tool' }>[]
  /** The run is still going, so a call in here may still be open. */
  streaming: boolean
}) {
  const [open, setOpen] = useState(false)
  const summary = steps.map(({ beat }) => ({ tool: beat.tool, action: beat.done }))

  /* The desktop gates this on the burst being the LAST segment, because its
     parts cannot be trusted to say which call is still open. Ours can — the
     ledger reports each call's own status — so the gate is the run being live
     and the row being unfinished, and nothing else. It matters: a run that
     fires two calls in parallel and narrates between their results leaves the
     open one in an earlier segment, and the position rule would go quiet on
     exactly the row still doing the work. */
  const running = streaming && steps.some(({ beat }) => beat.running === true)

  const rows = steps.map(({ beat, key }) => (
    <Step key={key} beat={beat} live={streaming && beat.running === true} />
  ))

  if (steps.length === 0) return null
  if (steps.length === 1) return <>{rows}</>

  /* Live, the burst opens and says what it is doing over the top of its own
     rows. The dots are here and nowhere else in this file: a burst is several
     tools at once and has no single mark to show, which is the whole condition
     for using them. Each row underneath still shows its own tool's mark. */
  if (running) {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2.5 py-0.5 text-ink-2">
          <DotsLoader />
          <span className="bui-shimmer min-w-0 truncate text-[13px]">
            {summarizeBurst(summary, true)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 pl-[26px]">{rows}</div>
      </div>
    )
  }

  const { marks, overflow } = burstMarks(summary)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2.5 py-0.5 text-left text-[13px] text-ink-2 transition-colors duration-100 hover:text-ink"
      >
        {/* Leads the row in the same slot a single call gives its own mark, so
            the log's left edge is a column of marks rather than a column of
            arrows. Kept when open too — the line must not shift sideways as it
            unfolds. */}
        <span className="flex shrink-0 items-center gap-1">
          {marks.map((name) => <ToolMark key={name} name={name} size={14} dim />)}
          {overflow > 0 && (
            <span className="text-[11px] text-ink-3 tabular-nums">+{overflow}</span>
          )}
        </span>
        <span className="min-w-0 truncate">{summarizeBurst(summary, false)}</span>
        <ChevronRight
          size={13}
          className={`shrink-0 text-ink-3 opacity-0 transition-all duration-150 group-hover:opacity-100 ${open ? 'rotate-90 opacity-100' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-1 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line pl-4">
          {rows}
        </div>
      )}
    </div>
  )
}

/* ── Timeline ─────────────────────────────────────────────
   The whole log, under the one control that folds it.

   Open while the run is going, folded the moment there is an answer to read
   instead — and forced open by an approval, whose controls must stay reachable.
   A click pins it either way, because someone who opened the log to read it
   should not have it shut in their face when the run happens to finish. */
/**
 * The clock, and the only thing in the thread that ticks.
 *
 * A running duration used to live in the thread's own state, refreshed every
 * 100ms — which re-rendered every exchange, every step and every answer, and
 * reparsed the markdown of a streaming reply, ten times a second, to move one
 * digit. The start is a constant; only its label has to keep up, so the timer
 * lives here, in the smallest thing that draws it.
 *
 * Read off the start rather than accumulated per tick: an interval is not paced
 * to the millisecond and a background tab throttles it to roughly once a
 * second, so a counter that added up its own ticks would under-report a long
 * run by half while the work carried on.
 */
function Elapsed({ startedAt, seconds }: { startedAt: number | null; seconds: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return
    const tick = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(tick)
  }, [startedAt])

  return <>{elapsedLabel(startedAt === null ? seconds : (now - startedAt) / 1000)}</>
}

export function PiTraceTimeline({
  steps, streaming, startedAt, elapsed, liveLabel,
}: {
  steps: TraceStep[]
  /** The run is going. */
  streaming: boolean
  /** When the run started, while it is going. */
  startedAt: number | null
  /** How long the run took, once it is over. */
  elapsed: number
  /** What the run says it is doing right now. */
  liveLabel?: string | null
}) {
  const [pinned, setPinned] = useState<boolean | null>(null)
  const open = pinned ?? streaming
  const segments = coalesceSegments(steps)
  // A call that spawned agents is still a call the run made, and leaving it out
  // made the count disagree with the log directly under it.
  const tools = steps.filter((step) => step.kind === 'tool' || step.kind === 'agents').length
  const working = streaming

  // A turn that answered without doing anything has no log and no header —
  // "Worked for 0.4s" above a one-line reply is furniture, not information.
  if (segments.length === 0 && !working) return null

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPinned(!open)}
        className="group flex w-fit items-center gap-2.5 py-1 text-[13px] text-ink-2 transition-colors duration-100 hover:text-ink"
      >
        {working ? (
          <>
            <PixelGrid />
            {/* The run's own words for what it is doing, falling back to a
                generic verb only before the first frame arrives. */}
            <Shimmer>{liveLabel || 'Working'}</Shimmer>
            <span className="font-mono text-[12px] text-ink-3 tabular-nums">
              <Elapsed startedAt={startedAt} seconds={elapsed} />
            </span>
          </>
        ) : (
          <>
            {/* Divo's own mark, not a generic sparkle. This row is the product
                reporting on what it just did, and a sparkle says "AI happened
                here" — a sticker the whole industry wears, claiming novelty
                rather than authorship. It is the desktop's glyph exactly: the
                same product signs its work the same way on both surfaces. */}
            <DivoMark className="size-[15px] text-ink-3 transition-colors duration-100 group-hover:text-ink-2" />
            <span className="font-medium">
              Worked for{' '}
              <Elapsed startedAt={startedAt} seconds={elapsed} />
            </span>
            {tools > 0 && (
              <span className="text-[12px] text-ink-3 tabular-nums">
                {tools} {tools === 1 ? 'step' : 'steps'}
              </span>
            )}
          </>
        )}
        {segments.length > 0 && (
          <ChevronDown
            size={14}
            className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <TimelineBody segments={segments} streaming={working} />
        </div>
      </div>
    </div>
  )
}

function TimelineBody({
  segments, streaming,
}: {
  segments: TraceSegment[]
  streaming: boolean
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      {segments.map((segment) => {
        /* Whether a segment is live is asked of the segment, not of its
           position. The desktop uses "is this the last one" because its parts
           do not carry a reliable status; ours do, and a run with two calls in
           flight has two live segments however they are ordered. */
        if (segment.kind === 'tools') {
          /* Named by the call it opens with rather than by where the burst
             sits, so a burst that gains a row above it is the same burst. */
          return (
            <CommandGroup
              key={`tools:${segment.steps[0]!.key}`}
              steps={segment.steps}
              streaming={streaming}
            />
          )
        }
        if (segment.kind === 'agents') {
          return <AgentRunView key={`agents:${segment.step.key}`} run={segment.step.beat.run} />
        }
        if (segment.step.kind === 'thought') {
          return (
            <ThoughtStep
              key={`thought:${segment.step.key}`}
              text={segment.step.text}
              live={streaming && segment.step.live}
            />
          )
        }
        // Narration is content, not metadata, so it gets the answer's own
        // renderer — the model writes markdown whatever it is doing, and prose
        // that reads as a broken list because it landed in a log is prose the
        // log has damaged. One weight below the answer, so the reply is still
        // the brightest thing in the turn.
        return (
          <div
            key={`talk:${segment.step.key}`}
            className="py-1 text-[13px] leading-[1.65] text-ink-2"
            /* Each sentence resolves out of blur as it lands. These genuinely
               arrive one at a time — unlike the answer, which is complete when
               it gets here — so the animation is reporting an arrival rather
               than performing one. It was lost when this moved inline. */
            style={{ animation: 'bui-stream-in 420ms cubic-bezier(0.22,0.61,0.25,1) both' }}
          >
            <Markdown>{segment.step.text}</Markdown>
          </div>
        )
      })}
    </div>
  )
}
