/**
 * What the thread is showing, and how far through.
 *
 * This file used to hold `useRunPlayer`, which scheduled a scripted transcript
 * on `setTimeout` because there was no backend to ask. `live.ts` replaced it
 * with a real stream and produces exactly this shape — which is the whole
 * reason the swap cost no component below it.
 *
 * The two ideas it owned are still the two ideas:
 *
 * Of the two ideas it owned, one survived.
 *
 * A **cursor** did not. A script needed one — the beats all existed from the
 * first frame, so something had to say how far in the reader was. A stream has
 * no future to hide: a beat is on screen because the run reported it, and
 * whether it is still going is a fact each row carries about itself. The cursor
 * was position standing in for status, and it got the answer wrong the moment a
 * run narrated over a tool call that was still open.
 *
 * A **gate** did. An approval is the one beat that is on screen without having
 * happened, so it is still tracked apart from the rest. Nothing resumes the run
 * but an answer, and a declined one ends there carrying the beat's `declined`
 * line, because a person saying no is a legitimate ending and not an error.
 */

export type RunState = {
  /** Beats that have happened, in order. Index into `run.beats`. */
  played: number[]
  /** The approval beat waiting on an answer, or `null`. */
  gate: number | null
  /** Set once the reader declines — carries the beat's `declined` sentence. */
  declined: string | null
  finished: boolean
  /** Wall time the run has been going, in seconds. Freezes when it ends. */
  elapsed: number
}

export function elapsedLabel(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  return `${m}m ${(seconds % 60).toFixed(0)}s`
}
