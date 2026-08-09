/**
 * The little that all four Mail Ops repositories share.
 *
 * Deliberately small. Each repository below declares the models it actually
 * touches rather than taking this union, so a delivery repository cannot reach
 * a subscription row by accident and a reader can see an aggregate's whole
 * surface from its constructor.
 *
 * There are five aggregates now, not four: the brief joined them.
 */
import type { PrismaClient } from '../../../generated/prisma';

export type MailOpsDb = Pick<
  PrismaClient,
  | 'mailboxSubscription'
  | 'mailboxReconciliation'
  | 'mailAutomationRule'
  | 'mailEvent'
  | 'mailDelivery'
  | 'mailBrief'
  | '$transaction'
  | '$executeRaw'
>;

export const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * How many times a claim looks again after losing the row it picked.
 *
 * Every claim here is a compare-and-swap: read the next due row, then write it
 * only if nothing has touched it since. Losing that write means somebody else
 * took the row — not that there is no work — and the two are indistinguishable
 * to the caller if both come back empty. Serially that never mattered, because
 * there was nobody to lose to. With lanes it is the common case at the start of
 * a drain, and a lane that reads an empty claim as an empty queue abandons the
 * whole batch on its first collision.
 *
 * So a lost race looks again instead. The row the winner took now fails the
 * search's own predicate — claimed, or no longer `pending` — so the retry
 * naturally lands on the next one rather than fighting over the same row.
 *
 * Bounded rather than unbounded: under real contention a few passes are always
 * enough, and past that returning empty is honest — every row this claim can
 * see is already being worked by somebody.
 */
export const MAIL_CLAIM_CONTENTION_ATTEMPTS = 5;
