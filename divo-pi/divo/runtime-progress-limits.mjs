/**
 * How much of each thing a run reports is allowed onto the wire, and which end
 * of it survives.
 *
 * One table, because a bound applied at two points on one wire is not two
 * bounds — it is one rule written down twice, and the copies drift. They had:
 * a child's detail was cut at 64 here and 80 on the far side, and a child's
 * elapsed time was uncapped here and cut at 16 there. Neither disagreement had
 * any effect, because in both cases one side happened to be stricter and got
 * there first. That is the whole danger: the numbers are wrong already and the
 * only reason nothing is broken is the order they run in.
 *
 * **The direction is part of the bound, not a detail of how it is applied.**
 * Most of these are a whole short thing whose front is the useful part — a
 * label, a file name, a sentence — so they keep their head. Reasoning is not:
 * it accumulates from the start of the block and is re-sent in full on every
 * delta, so cutting its front means that once it passes the bound the value
 * stops changing for the rest of the run. It froze in production for exactly
 * this reason, twice, and raising the number only moved where it froze. A bound
 * that travels without its direction invites the same bug a third time.
 *
 * The container cannot import backend code, so
 * `advance-backend/src/application/runtime/progress-limits.ts` holds the same
 * table on the far side of the wall. **Changing a bound means editing both**;
 * `progress-limits-parity.test.ts` fails if they disagree.
 *
 * Only text a person reads is in here. A call id and a tool name are matched,
 * not read, and every bound in this table ends in an ellipsis — which turns a
 * clamped identifier into a different identifier that still compares unequal to
 * the one it came from. Those keep a plain clamp of their own.
 */

/**
 * @typedef {{ max: number, keep: 'head' | 'tail' }} ProgressBound
 */

/** @type {Readonly<Record<string, ProgressBound>>} */
export const PROGRESS_BOUNDS = Object.freeze({
	/** A row's title — a tool name, an agent's role, a checklist item. */
	label: Object.freeze({ max: 80, keep: "head" }),
	/** What a call is about: a command, a file name, an operation. */
	detail: Object.freeze({ max: 64, keep: "head" }),
	/** One thing the model said, as it says it. */
	say: Object.freeze({ max: 200, keep: "head" }),
	/**
	 * The model reasoning to itself.
	 *
	 * Far more room than a sentence because it is not one — it is routinely a
	 * paragraph, and it never appears on a Lark card, which is what 200 was
	 * sized for. Kept from its end; see the note above.
	 */
	thought: Object.freeze({ max: 1_200, keep: "tail" }),
	/** A running child's duration, already formatted — "1m 30s". */
	elapsed: Object.freeze({ max: 16, keep: "head" }),
});

/** How many rows of a list cross at all. */
export const PROGRESS_LIST_LIMITS = Object.freeze({
	children: 8,
	todos: 12,
});

/**
 * Apply a bound, in its own direction.
 *
 * Whitespace is flattened first: these values are rendered into single-line
 * rows, and a newline that survives to a Lark card breaks the markup around it.
 *
 * A head cut ends in an ellipsis and a tail cut begins with one, because the
 * ellipsis is what says the value is a view onto something longer rather than
 * the whole of it. A tail cut also starts on a word boundary — landing
 * mid-word reads as corrupted rather than scrolled. `indexOf` of a missing
 * space is -1, so an unbroken run of characters keeps the whole tail rather
 * than losing all of it.
 *
 * @param {unknown} value
 * @param {ProgressBound} bound
 * @returns {string | undefined}
 */
export function boundedProgressText(value, bound) {
	if (typeof value !== "string") return undefined;
	const flat = value.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	if (flat.length <= bound.max) return flat;
	if (bound.keep === "head") return `${flat.slice(0, bound.max - 1)}…`;
	const tail = flat.slice(-(bound.max - 1));
	return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}
