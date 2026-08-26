/**
 * A loose end, and the vocabulary for talking about one.
 *
 * The types here are the contract between the analyser, the store and the
 * digest. They deliberately describe a *team's* outstanding work rather than a
 * person's: nothing in this file names a member, and nothing should.
 */

/** What kind of loose end this is. The analyser may return no other value. */
export type FollowUpKind =
  | 'commitment'
  | 'unanswered_question'
  | 'request'
  | 'deadline'
  | 'decision_pending';

export const FOLLOW_UP_KINDS: readonly FollowUpKind[] = [
  'commitment',
  'unanswered_question',
  'request',
  'deadline',
  'decision_pending',
];

/**
 * Which side owes the action.
 *
 * `us` means Urban Aura owes it; `them` means Urban Aura is waiting on somebody
 * else. This is a *side*, not an assignee — the team runs one shared pool and
 * asked for no per-person mapping. The imported agent called these `me`/`them`
 * because it served a single account holder; the rename is the whole difference
 * between "you owe this" and "we owe this", and the digest wording follows it.
 */
export type FollowUpOwner = 'us' | 'them';

export type FollowUpUrgency = 'low' | 'medium' | 'high';

export type FollowUpStatus = 'open' | 'resolved' | 'dismissed';

/** Where the item came from. A column, not an abstraction — see AGENTS.md rule 4. */
export type FollowUpSource = 'analysis' | 'manual';

/**
 * One item as the analyser reports it, before it is stored.
 *
 * `id` carries the incremental contract: a non-null id refreshes an item we are
 * already tracking, and null means newly spotted. Losing that distinction turns
 * every sweep into a fresh set of duplicates for the same loose end.
 */
export interface AnalyzedFollowUp {
  readonly id: string | null;
  readonly title: string;
  readonly detail: string;
  readonly kind: FollowUpKind;
  readonly owner: FollowUpOwner;
  readonly counterparty: string;
  /** `YYYY-MM-DD` when a date was stated or clearly implied, else null. */
  readonly dueDate: string | null;
  readonly urgency: FollowUpUrgency;
  readonly confidence: number;
  /**
   * Verbatim quotes from the transcript.
   *
   * Not decoration. A follow-up without evidence is an assertion the team has no
   * way to check, and the first wrong one costs more trust than the feature
   * earns back.
   */
  readonly evidence: readonly string[];
  readonly suggestedReply: string;
}

/** An item the analyser says is finished, and why. */
export interface ResolvedFollowUp {
  readonly id: string;
  readonly reason: string;
}

/**
 * One analysis pass over one chat.
 *
 * An item we are already tracking that appears in neither array is left open and
 * untouched. That silence is meaningful: it means the new messages said nothing
 * about it, which is not the same as saying it is done.
 */
export interface FollowUpAnalysis {
  readonly openItems: readonly AnalyzedFollowUp[];
  readonly resolved: readonly ResolvedFollowUp[];
}

/** An item already being tracked, as handed to the analyser for reconciliation. */
export interface TrackedFollowUp {
  readonly id: string;
  readonly title: string;
  readonly kind: FollowUpKind;
  readonly owner: FollowUpOwner;
  readonly counterparty: string;
  readonly dueDate: string | null;
  /**
   * Closed by a person, rather than still open.
   *
   * Carried into the prompt for one reason: a closed item is invisible to the
   * model unless we show it, so the same commitment gets spotted again on the
   * next pass and filed as brand new. From the team's side that reads as a
   * dismiss button that does not work — the item they just cleared is back in
   * the morning, with a different id, so nothing about it can be traced.
   *
   * Showing them is what makes closing an item mean something. The model is
   * told not to raise these again, and `applyPlan` separately refuses to
   * reopen a non-open row by id, so neither path can undo the decision.
   */
  readonly closedByTeam?: boolean;
}

/**
 * Reject an item the analyser is not sure enough about.
 *
 * The floor is a product decision, not a tuning knob: a missed reminder costs
 * the team far less than a wrong one, because a wrong one is read, acted on, and
 * remembered.
 */
export function meetsConfidenceFloor(
  item: AnalyzedFollowUp,
  floor: number,
): boolean {
  return Number.isFinite(item.confidence) && item.confidence >= floor;
}

/** How the digest introduces an item. `owner` is a side, so this reads as a team. */
export function ownerLabel(
  owner: FollowUpOwner,
  counterparty: string,
): string {
  if (owner === 'us') return 'We owe';
  return counterparty.trim() ? `Waiting on ${counterparty.trim()}` : 'Waiting on them';
}
