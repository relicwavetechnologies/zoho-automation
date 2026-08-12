/**
 * The agent's lifecycle, in the desktop's own vocabulary.
 *
 * This is a port, and deliberately a literal one. The web surface had grown its
 * own arrangement of the same facts — log blocks, work beats, bursts assembled
 * one way here and another way there — and every disagreement with the desktop
 * came from the two describing a run differently rather than from either being
 * wrong about a pixel. So the model is the desktop's, named the same:
 *
 *   thought    — the model reasoning to itself
 *   narration  — the model talking to you *while* it works
 *   tool       — a call it made
 *
 * One flat list, in the order the run produced it, and one rule for shaping it:
 * **consecutive tool calls coalesce into a burst; talking of either kind breaks
 * the burst.** That is `coalesceSegments`, copied from the desktop's
 * `PiTraceTimeline`. It is worth naming what it does NOT do: it does not group
 * by vendor. Four calls to one system are one burst because they were adjacent,
 * not because they were Zoho — and a file read followed by three Zoho calls is
 * also one burst, for the same reason. What separates them on screen is the
 * model saying something in between, which is most of the time, and is exactly
 * how the desktop reads.
 *
 * The other half of the desktop's `split-trace-parts.ts` is not here, because
 * the backend already did it: the answer arrives as its own `final` event
 * rather than as the last text part of a message, so there is nothing to work
 * out about which text was the deliverable.
 *
 * Kept apart from `trace.tsx` the way the desktop keeps `lib/pi/` apart from
 * `components/pi/` — the rules are worth testing on their own, and the view
 * they drive pulls in a stylesheet that a test runner cannot load.
 */
import type { Beat } from './transcripts'

export type TraceStep =
  | { kind: 'thought'; index: number; text: string; live: boolean }
  | { kind: 'narration'; index: number; text: string }
  | { kind: 'tool'; index: number; beat: Extract<Beat, { t: 'step' }> }

export type TraceSegment =
  /** One stretch of talking — a thought or a narration, never both. */
  | { kind: 'talk'; step: Extract<TraceStep, { kind: 'thought' | 'narration' }> }
  /** Consecutive calls that ran back to back with no talking between them. */
  | { kind: 'tools'; steps: Extract<TraceStep, { kind: 'tool' }>[] }

/**
 * The run, split into what it did and what it produced.
 *
 * Everything that happened on the way is the trace; everything else — an
 * approval waiting on a person, a table, the answer — stays in the conversation
 * in the order the run put it there. Ordering carries meaning out here: the
 * invoice run draws its ageing chart *before* it asks permission to send
 * anything, and a layout that sorted by kind printed the chart underneath the
 * approval it existed to inform.
 */
export function splitTrace(beats: readonly Beat[]): {
  trace: TraceStep[]
  rest: { beat: Beat; index: number }[]
} {
  const trace: TraceStep[] = []
  const rest: { beat: Beat; index: number }[] = []

  beats.forEach((beat, index) => {
    if (beat.t === 'step') {
      trace.push({ kind: 'tool', index, beat })
      return
    }
    if (beat.t === 'think') {
      trace.push({ kind: 'thought', index, text: beat.text, live: beat.running === true })
      return
    }
    if (beat.t === 'say' && beat.narration === true) {
      trace.push({ kind: 'narration', index, text: beat.text })
      return
    }
    rest.push({ beat, index })
  })

  return { trace, rest }
}

/** Ported from the desktop's `PiTraceTimeline.coalesceSegments`, rule for rule. */
export function coalesceSegments(steps: readonly TraceStep[]): TraceSegment[] {
  const segments: TraceSegment[] = []
  for (const step of steps) {
    if (step.kind === 'tool') {
      const last = segments[segments.length - 1]
      if (last && last.kind === 'tools') last.steps.push(step)
      else segments.push({ kind: 'tools', steps: [step] })
    } else if (step.text.trim()) {
      segments.push({ kind: 'talk', step })
    }
  }
  return segments
}
