import { Prisma, type PrismaClient } from '../../../generated/prisma';
import {
  MAILBOX_CLAIM_STALE_AFTER_MS,
  MAIL_DELIVERY_MAX_ATTEMPTS,
  MAIL_DELIVERY_RETRY_BASE_MS,
  mailDeliveryIdempotencyKey,
} from '../../../application/mail-ops/mail-ops.types';
import { wrapInfra, type InfraError } from '../../../shared/errors';
import { err, ok, type Result } from '../../../shared/result';
import { errorText } from './shared';

type MailDeliveryDb = Pick<PrismaClient, 'mailDelivery'>;

export type MailDeliveryReservation =
  | { outcome: 'reserved'; deliveryId: string }
  | { outcome: 'delivered'; deliveryId: string }
  | { outcome: 'in_flight' }
  | { outcome: 'abandoned' };

export interface ClaimedMailDelivery {
  deliveryId: string;
  attempts: number;
  payload: Record<string, unknown>;
  /**
   * The draft staged by a previous attempt, when there was one. The whole
   * exactly-once guarantee reads this: without it the worker cannot ask Gmail
   * whether the last attempt's send completed.
   */
  providerDraftId?: string;
}

/**
 * One message's journey out of the mailbox: reserved once, retried on a ladder,
 * and ending in exactly one terminal state.
 */
export class MailDeliveryRepository {
  constructor(private readonly db: MailDeliveryDb) {}

  async reserveDelivery(
    companyId: string,
    subscriptionId: string,
    ruleId: string,
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<Result<MailDeliveryReservation, InfraError>> {
    const idempotencyKey = mailDeliveryIdempotencyKey(ruleId, eventId);
    try {
      try {
        const created = await this.db.mailDelivery.create({
          data: {
            companyId,
            subscriptionId,
            ruleId,
            eventId,
            idempotencyKey,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
            payloadJson: payload as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        return ok({ outcome: 'reserved', deliveryId: created.id });
      } catch (cause) {
        if ((cause as { code?: string }).code !== 'P2002') throw cause;
      }

      const existing = await this.db.mailDelivery.findUnique({
        where: { idempotencyKey },
        select: { id: true, status: true },
      });
      if (!existing) {
        throw new Error('Mail delivery uniqueness conflict without a winner.');
      }
      if (existing.status === 'delivered') {
        return ok({ outcome: 'delivered', deliveryId: existing.id });
      }
      if (existing.status === 'abandoned') {
        return ok({ outcome: 'abandoned' });
      }
      return ok({ outcome: 'in_flight' });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.reserveDelivery', cause));
    }
  }

  /**
   * How many messages this rule has already sent, or is about to, in the window.
   *
   * `blocked` and `abandoned` rows are excluded because neither is a message
   * anybody received: counting a refusal against the ceiling would mean a rule
   * that hit its limit once could never recover, since the refusals it then
   * recorded would keep it at the limit forever.
   *
   * Counted once per message rather than once per attempt: the window is keyed
   * on the mail's own arrival time, so a retry an hour later still falls in the
   * hour the mail arrived in. The mail only leaves once, so it only costs one
   * slot.
   */
  async countRecentDeliveries(input: {
    ruleId: string;
    since: Date;
    until: Date;
    exceptEventId: string;
  }): Promise<Result<number, InfraError>> {
    try {
      return ok(await this.db.mailDelivery.count({
        where: {
          ruleId: input.ruleId,
          status: { notIn: ['blocked', 'abandoned'] },
          // The message being judged never counts against its own ceiling. It
          // is excluded by identity rather than by keeping the window open
          // above it, because a retry of an event that already has a row would
          // otherwise count itself and refuse to make progress.
          eventId: { not: input.exceptEventId },
          // The hour is measured on the mail's own arrival time, through the
          // event, and not on when Divo got round to reserving the delivery.
          //
          // Counting `firstAttemptAt` gave the right answer only while Divo was
          // keeping up. Drain a backlog after an outage and every row reserved
          // in that pass carries the same `firstAttemptAt` of *now*, so a
          // hundred messages that arrived at a genuine seventeen an hour all
          // land in one window and everything past the ceiling is dropped —
          // mail the rule never came close to exceeding its limit on. An
          // outage would turn a rate limit into permanent loss.
          //
          // Both ends are bounded for the same reason: without an upper bound a
          // drain also counts deliveries for mail that arrived *after* the
          // message being judged.
          //
          // Inclusive at the top. Gmail's `internalDate` is milliseconds but
          // routinely carries only second precision, so a mailing-list burst —
          // the case a ceiling is for — arrives as a group sharing one
          // `occurredAt`. Excluded from each other's windows, fifty such
          // messages each saw an empty hour and all fifty went out under a
          // limit of five.
          event: { occurredAt: { gte: input.since, lte: input.until } },
        },
      }));
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.countRecentDeliveries', cause));
    }
  }

  /**
   * Records that a matching message was refused, durably.
   *
   * Until now a refusal was a log line and nothing else, which is why the
   * production numbers showed events accumulating while deliveries stopped
   * dead: from the outside it was indistinguishable from mail that simply
   * never matched. A `blocked` row is inert — `claimNextDueDelivery` only ever
   * picks up `pending` — so this can never turn into a send.
   *
   * Idempotent on the same `(rule, event)` key as a real delivery, and it
   * deliberately loses to one: if a delivery already exists for this pair, the
   * refusal came second and the existing row is the truth.
   */
  async recordBlockedDelivery(input: {
    companyId: string;
    subscriptionId: string;
    ruleId: string;
    eventId: string;
    reason: string;
    message: Record<string, unknown>;
  }): Promise<Result<boolean, InfraError>> {
    const idempotencyKey = mailDeliveryIdempotencyKey(
      input.ruleId,
      input.eventId,
    );
    try {
      await this.db.mailDelivery.create({
        data: {
          companyId: input.companyId,
          subscriptionId: input.subscriptionId,
          ruleId: input.ruleId,
          eventId: input.eventId,
          idempotencyKey,
          status: 'blocked',
          attempts: 0,
          nextAttemptAt: null,
          lastError: input.reason.slice(0, 500),
          // Only the message, never an action or destination: this row exists
          // to name the mail that was refused, not to describe a send.
          payloadJson: { message: input.message } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return ok(true);
    } catch (cause) {
      if ((cause as { code?: string }).code === 'P2002') return ok(false);
      return err(wrapInfra('prisma', 'mailOps.recordBlockedDelivery', cause));
    }
  }

  async claimNextDueDelivery(
    now = new Date(),
  ): Promise<Result<ClaimedMailDelivery | null, InfraError>> {
    try {
      const staleBefore = new Date(now.getTime() - MAILBOX_CLAIM_STALE_AFTER_MS);
      // A worker that died mid-attempt on the last rung has nowhere to go: the
      // claim already spent the attempt, and the search below refuses anything
      // at the ceiling. Returning such a row to `pending` stranded it there for
      // the life of the table — never claimed, never abandoned, and still
      // wearing whatever `ambiguous` said about it. `ambiguous` is left exactly
      // as it was, because a process that died during a send genuinely did not
      // establish whether the mail went out.
      await this.db.mailDelivery.updateMany({
        where: {
          status: 'sending',
          startedAt: { lt: staleBefore },
          attempts: { gte: MAIL_DELIVERY_MAX_ATTEMPTS },
        },
        data: {
          status: 'abandoned',
          nextAttemptAt: null,
          lastError: 'The worker stopped mid-attempt on the last retry.',
        },
      });
      await this.db.mailDelivery.updateMany({
        where: {
          status: 'sending',
          startedAt: { lt: staleBefore },
          attempts: { lt: MAIL_DELIVERY_MAX_ATTEMPTS },
        },
        data: { status: 'pending', nextAttemptAt: now },
      });
      const due = await this.db.mailDelivery.findFirst({
        where: {
          status: 'pending',
          attempts: { lt: MAIL_DELIVERY_MAX_ATTEMPTS },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          attempts: true,
          nextAttemptAt: true,
          payloadJson: true,
          providerDraftId: true,
        },
      });
      if (!due?.payloadJson) return ok(null);
      const claimed = await this.db.mailDelivery.updateMany({
        where: {
          id: due.id,
          status: 'pending',
          attempts: due.attempts,
          nextAttemptAt: due.nextAttemptAt,
        },
        data: {
          status: 'sending',
          attempts: { increment: 1 },
          startedAt: now,
        },
      });
      if (claimed.count !== 1) return ok(null);
      return ok({
        deliveryId: due.id,
        attempts: due.attempts + 1,
        payload: due.payloadJson as Record<string, unknown>,
        // Present only on a retry of an attempt that got as far as staging.
        // Whether that attempt also sent is the question the worker asks Gmail.
        ...(due.providerDraftId ? { providerDraftId: due.providerDraftId } : {}),
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.claimNextDueDelivery', cause));
    }
  }

  /**
   * Records the draft a forward is staged in, before anything is sent.
   *
   * `ambiguous` is set in the same write and cleared only by a confirmed
   * outcome. Between the two, this row is honest about not knowing whether
   * Gmail sent the message — which is the state the old search-based guard
   * pretended it could always resolve.
   */
  async stageDeliveryDraft(input: {
    deliveryId: string;
    attempts: number;
    providerDraftId: string;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailDelivery.updateMany({
        where: {
          id: input.deliveryId,
          status: 'sending',
          attempts: input.attempts,
        },
        data: {
          providerDraftId: input.providerDraftId,
          ambiguous: true,
        },
      });
      return ok(updated.count === 1);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.stageDeliveryDraft', cause));
    }
  }

  async markDeliveryDelivered(
    deliveryId: string,
    providerMessageId?: string,
    now = new Date(),
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailDelivery.updateMany({
        where: { id: deliveryId, status: 'sending' },
        data: {
          status: 'delivered',
          deliveredAt: now,
          nextAttemptAt: null,
          lastError: null,
          ambiguous: false,
          // The draft is consumed by the send, so its ID is spent. Clearing it
          // keeps a delivered row from looking like one still mid-flight.
          providerDraftId: null,
          ...(providerMessageId ? { providerMessageId } : {}),
        },
      });
      return ok(updated.count === 1);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.markDeliveryDelivered', cause));
    }
  }

  async markDeliveryFailed(
    deliveryId: string,
    cause: unknown,
    attempts: number,
    now = new Date(),
    options?: { readonly nothingWasSent?: boolean },
  ): Promise<Result<boolean, InfraError>> {
    const abandoned = attempts >= MAIL_DELIVERY_MAX_ATTEMPTS;
    const backoffMs = MAIL_DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
    try {
      const updated = await this.db.mailDelivery.updateMany({
        where: { id: deliveryId, status: 'sending', attempts },
        data: {
          status: abandoned ? 'abandoned' : 'pending',
          lastError: errorText(cause),
          nextAttemptAt: abandoned ? null : new Date(now.getTime() + backoffMs),
          // Only on the last rung, and only when the caller proved it. While
          // the row is still retryable the next attempt re-probes and answers
          // the question properly; once it is abandoned nothing ever will, so
          // this is the last chance to stop telling the member their mail
          // might be in somebody's inbox when it provably is not.
          ...(abandoned && options?.nothingWasSent ? { ambiguous: false } : {}),
        },
      });
      return ok(updated.count === 1);
    } catch (error) {
      return err(wrapInfra('prisma', 'mailOps.markDeliveryFailed', error));
    }
  }

  /**
   * Puts a claimed delivery back without spending the attempt it was claimed
   * with.
   *
   * For refusals that are nobody's failure and will simply be true again later
   * — a connection over its budget, a policy store that could not be read. The
   * retry ladder abandons at five attempts with backoff totalling about
   * seventy-five seconds, so routing these through `markDeliveryFailed` threw
   * the mail away roughly a minute into an hour-long rate window and left the
   * row terminal, unclaimable and undeliverable for good.
   */
  async rescheduleDelivery(input: {
    deliveryId: string;
    attempts: number;
    nextAttemptAt: Date;
    reason: string;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailDelivery.updateMany({
        where: {
          id: input.deliveryId,
          status: 'sending',
          attempts: input.attempts,
        },
        data: {
          status: 'pending',
          // Handing back what the claim took. Waiting is not an attempt.
          attempts: { decrement: 1 },
          lastError: input.reason.slice(0, 500),
          nextAttemptAt: input.nextAttemptAt,
        },
      });
      return ok(updated.count === 1);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.rescheduleDelivery', cause));
    }
  }

  async markDeliveryAbandoned(
    deliveryId: string,
    attempts: number,
    reason: string,
    options?: { readonly nothingWasSent?: boolean },
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailDelivery.updateMany({
        where: { id: deliveryId, status: 'sending', attempts },
        data: {
          status: 'abandoned',
          lastError: reason.slice(0, 500),
          nextAttemptAt: null,
          // Only when the caller actually established it. `ambiguous` reads to
          // the member as "this may already be in somebody's inbox", and a
          // delivery that is being abandoned will never resolve that question
          // later — so a caller that has proved the mail never went out is the
          // last chance to take the warning down. `providerDraftId` stays: the
          // draft is still sitting in the mailbox and the row is the only
          // record of which one it is.
          ...(options?.nothingWasSent ? { ambiguous: false } : {}),
        },
      });
      return ok(updated.count === 1);
    } catch (error) {
      return err(wrapInfra('prisma', 'mailOps.markDeliveryAbandoned', error));
    }
  }

  /**
   * Drops the frozen payload from deliveries that can no longer be retried.
   *
   * The payload holds a second copy of the message body, and it exists to let
   * an attempt be repeated — so once a delivery is terminal it is dead weight
   * carrying the most sensitive thing in the table. Only terminal rows are
   * touched, and only well past the point where the retry ladder could still
   * reach them: `claimNextDueDelivery` refuses anything that is not `pending`,
   * but a row whose payload vanished while it was still claimable would be
   * unrecoverable, so the age is the guard rather than the status alone.
   */
  async dropTerminalPayloads(before: Date): Promise<Result<number, InfraError>> {
    try {
      const cleared = await this.db.mailDelivery.updateMany({
        where: {
          status: { in: ['delivered', 'abandoned', 'blocked'] },
          updatedAt: { lt: before },
          payloadJson: { not: Prisma.DbNull },
        },
        data: { payloadJson: Prisma.DbNull },
      });
      return ok(cleared.count);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.dropTerminalPayloads', cause));
    }
  }
}
