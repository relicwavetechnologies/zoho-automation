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
import type { Beat } from './beats'

/**
 * What a step is called by whoever draws it.
 *
 * `key` is the beat's own identity where it has one, and its position where it
 * does not — the scripted transcripts have no run behind them and never change
 * shape. Position alone was not enough: a snapshot can insert a step above
 * another, which renumbers every step below it, and a renderer keyed that way
 * rebuilds rows that never changed and replays their arrival animations.
 *
 * `index` is kept because it is still the beat's place in the run, which is
 * what the caller uses to put the trace and the answer back in order.
 */
export type TraceStep =
  | { kind: 'thought'; key: string; index: number; text: string; live: boolean }
  | { kind: 'narration'; key: string; index: number; text: string }
  | { kind: 'tool'; key: string; index: number; beat: Extract<Beat, { t: 'step' }> }
  /** A call that farmed its work out. Never folds into a burst — see below. */
  | { kind: 'agents'; key: string; index: number; beat: Extract<Beat, { t: 'agents' }> }

export type TraceSegment =
  /** One stretch of talking — a thought or a narration, never both. */
  | { kind: 'talk'; step: Extract<TraceStep, { kind: 'thought' | 'narration' }> }
  /** Consecutive calls that ran back to back with no talking between them. */
  | { kind: 'tools'; steps: Extract<TraceStep, { kind: 'tool' }>[] }
  /** The agents a call spawned, always on their own. */
  | { kind: 'agents'; step: Extract<TraceStep, { kind: 'agents' }> }

/**
 * The work log, in the vocabulary the timeline draws.
 *
 * A total mapping, and it did not use to be. This was `splitTrace`: it took one
 * array holding both the log and the answer and pulled them apart again, having
 * been handed them glued together one step earlier. The two are on completely
 * different clocks — the log changes about once a second, the answer changes
 * with every token — so joining them meant the whole log was rebuilt at the
 * answer's rate and every row in it redrawn to show the same thing.
 *
 * They are now built apart and never meet, so there is nothing to split. What
 * arrives here is only ever the log, which is why every beat has a step to
 * become.
 */
export function traceSteps(beats: readonly Beat[]): TraceStep[] {
  return beats.flatMap((beat, index): TraceStep[] => {
    const key = beat.id ?? `beat:${index}`
    if (beat.t === 'step') return [{ kind: 'tool', key, index, beat }]
    if (beat.t === 'agents') return [{ kind: 'agents', key, index, beat }]
    if (beat.t === 'think') {
      return [{ kind: 'thought', key, index, text: beat.text, live: beat.running === true }]
    }
    return [{ kind: 'narration', key, index, text: beat.text }]
  })
}

/**
 * Ported from the desktop's `PiTraceTimeline.coalesceSegments`, rule for rule.
 *
 * With the desktop's one exception: a call that spawned agents does not join a
 * burst. A burst folds to a single "Ran 3 commands" line, and folding this one
 * in would hide a live list of four agents behind a count and a chevron — the
 * one row in the log whose whole content is underneath it. It also breaks the
 * burst around itself, so the calls before and after it stay in the order they
 * happened rather than closing up over the top of it.
 */
export function coalesceSegments(steps: readonly TraceStep[]): TraceSegment[] {
  const segments: TraceSegment[] = []
  for (const step of steps) {
    if (step.kind === 'agents') {
      segments.push({ kind: 'agents', step })
    } else if (step.kind === 'tool') {
      const last = segments[segments.length - 1]
      if (last && last.kind === 'tools') last.steps.push(step)
      else segments.push({ kind: 'tools', steps: [step] })
    } else if (step.text.trim()) {
      segments.push({ kind: 'talk', step })
    }
  }
  return segments
}
