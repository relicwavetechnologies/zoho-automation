/**
 * How far through the run the thread is.
 *
 * This file used to hold `useRunPlayer`, which scheduled a scripted transcript
 * on `setTimeout` because there was no backend to ask. `live.ts` replaced it
 * with a real stream and produces exactly this shape — which is the whole
 * reason the swap cost no component below it.
 *
 * Of the ideas it owned, none survived, and the type is what is left.
 *
 * A **cursor** went first. A script needed one — the beats all existed from the
 * first frame, so something had to say how far in the reader was. A stream has
 * no future to hide: a beat is on screen because the run reported it, and
 * whether it is still going is a fact each row carries about itself. The cursor
 * was position standing in for status, and it got the answer wrong the moment a
 * run narrated over a tool call that was still open.
 *
 * A **gate** outlived it on paper only. An approval is the one beat that is on
 * screen without having happened, which is a real idea — but the beat that
 * carried it was scripted furniture, the thread had no renderer for it, and the
 * two fields tracking it were written `null` at every call site and read at
 * none. Governance is the backend's, and when it reaches this surface it will
 * arrive on the timeline like everything else rather than through a shape left
 * behind for it.
 */

export type RunState = {
  finished: boolean
  /**
   * When the run started, while it is still going — not how long it has been
   * going.
   *
   * A duration that lives in state has to be recomputed on a timer, and a timer
   * in the thread's own state re-renders every exchange, every step and every
   * answer ten times a second to move one number. The start is a constant, so
   * the only thing that ticks is the label drawing it.
   */
  startedAt: number | null
  /** How long the run took, once it is over. */
  elapsed: number
}

export function elapsedLabel(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  return `${m}m ${(seconds % 60).toFixed(0)}s`
}
