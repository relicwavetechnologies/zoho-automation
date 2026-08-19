/**
 * How much of each thing a run reports is allowed onto the wire, and which end
 * of it survives.
 *
 * The mirror of `divo-pi/divo/runtime-progress-limits.mjs`. The container
 * cannot import backend code, so the table is stated once on each side of the
 * wall and `progress-limits-parity.test.ts` fails if the two disagree — the
 * same arrangement `pricing.ts` has with `runtime-models.mjs`.
 *
 * **Changing a bound means editing both.** They were not one table before, and
 * two pairs had already drifted apart: a child's detail was cut at 64 in the
 * container and 80 here, a child's elapsed time was uncapped there and cut at
 * 16 here, and a row's label was cut at 80 there against this file's 120
 * default. None of it showed, because in every case one side was stricter and
 * ran first. Reverse either of those facts and the reader sees a value cut
 * twice — once mid-word, by the looser rule that was never meant to fire.
 *
 * Applying it again on this side is not redundant. The container is a sandbox
 * running model-authored work; what it sends is input, and input is bounded on
 * arrival whatever it claims to have done to itself. The point of one table is
 * that the second application agrees with the first instead of quietly
 * contradicting it.
 *
 * Only text a person reads is in here. A call id and a tool name are matched,
 * not read, and every bound in this table ends in an ellipsis — which turns a
 * clamped identifier into a different identifier that still compares unequal to
 * the one it came from. Those keep a plain clamp of their own.
 */

export interface ProgressBound {
  readonly max: number;
  readonly keep: 'head' | 'tail';
}

export const PROGRESS_BOUNDS = {
  /** A row's title — a tool name, an agent's role, a checklist item. */
  label:    { max: 80,    keep: 'head' },
  /** What a call is about: a command, a file name, an operation. */
  detail:   { max: 64,    keep: 'head' },
  /** One thing the model said, as it says it. */
  say:      { max: 200,   keep: 'head' },
  /**
   * The model reasoning to itself.
   *
   * Kept from its **end**, and that is the bound's own property rather than a
   * choice made where it is applied. Reasoning accumulates from the start of
   * the block and is re-sent in full on every delta, so cutting its front means
   * that once it passes the bound the published value never changes again — a
   * frozen window, not a slow one, which a reader correctly reads as a hung
   * agent. It shipped that way twice; raising the number only moved where it
   * froze.
   */
  thought:  { max: 1_200, keep: 'tail' },
  /** A running child's duration, already formatted — "1m 30s". */
  elapsed:  { max: 16,    keep: 'head' },
} as const satisfies Record<string, ProgressBound>;

export type ProgressBoundName = keyof typeof PROGRESS_BOUNDS;

/** How many rows of a list cross at all. */
export const PROGRESS_LIST_LIMITS = {
  children: 8,
  todos:    12,
} as const;

/**
 * Apply a bound, in its own direction.
 *
 * Whitespace is flattened first: these values are rendered into single-line
 * rows, and a newline that survives to a Lark card breaks the markup around it.
 *
 * A head cut ends in an ellipsis and a tail cut begins with one — the ellipsis
 * is what says the value is a view onto something longer. A tail cut also
 * starts on a word boundary, because a window opening mid-word reads as
 * corrupted rather than scrolled; `indexOf` of a missing space is -1, so one
 * unbroken run of characters keeps the whole tail rather than losing all of it.
 */
export function boundProgressText(
  value: unknown,
  name: ProgressBoundName,
): string | undefined {
  const bound: ProgressBound = PROGRESS_BOUNDS[name];
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (flat.length <= bound.max) return flat;
  if (bound.keep === 'head') return `${flat.slice(0, bound.max - 1)}…`;
  const tail = flat.slice(-(bound.max - 1));
  return `…${tail.slice(tail.indexOf(' ') + 1)}`;
}
