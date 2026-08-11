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
 * A **cursor** — how far through the beats the run has got. Beats before it
 * have settled, the beat at it is live, beats after it have not happened and
 * are not rendered. That is what makes the surface read as a run rather than a
 * page: the reader is never shown a result that has not arrived.
 *
 * A **gate** — an approval stops the cursor dead. Nothing resumes it but an
 * answer. A declined run ends there, carrying the beat's `declined` line,
 * because a person saying no is a legitimate ending and not an error.
 */

export type RunState = {
  /** Beats that have happened, in order. Index into `run.beats`. */
  played: number[]
  /** The live beat, or `null` when the run is settled, gated, or declined. */
  live: number | null
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
