import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../../generated/prisma';
import {
  MAILBOX_CLAIM_STALE_AFTER_MS,
  MAILBOX_RECONCILIATION_INTERVAL_MS,
  MAILBOX_WATCH_RENEWAL_INTERVAL_MS,
} from '../../../application/mail-ops/mail-ops.types';
import { wrapInfra, type InfraError } from '../../../shared/errors';
import { err, ok, type Result } from '../../../shared/result';
import { errorText, MAIL_CLAIM_CONTENTION_ATTEMPTS } from './shared';

type MailboxSubscriptionDb = Pick<
  PrismaClient,
  'mailboxSubscription' | 'mailboxReconciliation' | '$transaction'
>;

export interface MailboxSyncClaim {
  subscriptionId: string;
  companyId: string;
  userId: string;
  connectionId: string;
  mailboxEmail: string;
  historyId?: string;
  /** Where the last truncated pass stopped, if one did. */
  historyPageToken?: string;
  signalVersion: number;
  claimToken: string;
}

export interface MailboxWatchClaim {
  subscriptionId: string;
  companyId: string;
  userId: string;
  connectionId: string;
  mailboxEmail: string;
  claimToken: string;
}

/**
 * The mailbox itself: who is watched, how far its cursor has come, and which
 * worker currently holds it.
 */
export class MailboxSubscriptionRepository {
  constructor(private readonly db: MailboxSubscriptionDb) {}

  /**
   * Claims the next mailbox due for reconciliation.
   *
   * This used to require a registered watch and a history cursor whenever
   * Pub/Sub was configured, which inverted the safety net: a mailbox whose
   * watch failed permanently — classically a Pub/Sub topic missing its
   * publisher grant — was excluded from the very poll that exists to cover a
   * missing watch. Its rules were 100% dead while the tool still called them
   * active.
   *
   * Both conditions are gone. Push stays the fast path; reconciliation is now
   * unconditional. A null cursor is already handled — `sync()` bootstraps from
   * the Gmail profile — so the first pass on such a mailbox sets a cursor and
   * the next one starts delivering.
   */
  async claimNextDueMailbox(
    now = new Date(),
  ): Promise<Result<MailboxSyncClaim | null, InfraError>> {
    const staleBefore = new Date(
      now.getTime() - MAILBOX_CLAIM_STALE_AFTER_MS,
    );
    try {
      // Retried rather than returned empty on a lost race: see
      // MAIL_CLAIM_CONTENTION_ATTEMPTS. A mailbox another lane just took no
      // longer matches the search below, so the next pass reads the one after
      // it instead of contesting the same row.
      for (
        let attempt = 0;
        attempt < MAIL_CLAIM_CONTENTION_ATTEMPTS;
        attempt++
      ) {
        const due = await this.db.mailboxSubscription.findFirst({
          where: {
            status: 'active',
            nextPollAt: { lte: now },
            OR: [
              { claimToken: null },
              { claimedAt: null },
              { claimedAt: { lt: staleBefore } },
            ],
          },
          orderBy: [{ nextPollAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            companyId: true,
            userId: true,
            connectionId: true,
            mailboxEmail: true,
            historyId: true,
            historyPageToken: true,
            nextPollAt: true,
            signalVersion: true,
          },
        });
        // The one empty answer that genuinely means empty.
        if (!due) return ok(null);

        const claimToken = randomUUID();
        const claimed = await this.db.mailboxSubscription.updateMany({
          where: {
            id: due.id,
            status: 'active',
            nextPollAt: due.nextPollAt,
            OR: [
              { claimToken: null },
              { claimedAt: null },
              { claimedAt: { lt: staleBefore } },
            ],
          },
          data: { claimToken, claimedAt: now, lastSyncAt: now },
        });
        if (claimed.count !== 1) continue;

        return ok({
          subscriptionId: due.id,
          companyId: due.companyId,
          userId: due.userId,
          connectionId: due.connectionId,
          mailboxEmail: due.mailboxEmail,
          ...(due.historyId ? { historyId: due.historyId } : {}),
          ...(due.historyPageToken
            ? { historyPageToken: due.historyPageToken }
            : {}),
          signalVersion: due.signalVersion,
          claimToken,
        });
      }
      return ok(null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.claimNextDueMailbox', cause));
    }
  }

  /**
   * Moves the mailbox cursor forward and releases the claim.
   *
   * `pollImmediately` exists for a partially drained backlog: the pass
   * succeeded, so this is not a failure and must not be scheduled like one,
   * but there is known unread history left and waiting an hour for the next
   * reconciliation would hold it. Same path as the Pub/Sub-signal case below,
   * for the same reason.
   */
  async advanceCursor(
    claim: MailboxSyncClaim,
    nextHistoryId: string,
    now = new Date(),
    options: {
      pollImmediately?: boolean;
      /**
       * The resume point for the next pass, or `null` to end the walk.
       *
       * Always written, because clearing it is what says a backlog finished.
       * A token left standing would resume a walk through history already
       * consumed.
       */
      pageToken?: string | null;
    } = {},
  ): Promise<Result<boolean, InfraError>> {
    const success = {
      historyId: nextHistoryId,
      ...(options.pageToken !== undefined
        ? { historyPageToken: options.pageToken }
        : {}),
      claimToken: null,
      claimedAt: null,
      lastSucceededAt: now,
      failureCode: null,
      lastError: null,
    };
    try {
      const advanced = await this.db.mailboxSubscription.updateMany({
        where: {
          id: claim.subscriptionId,
          status: 'active',
          claimToken: claim.claimToken,
          signalVersion: claim.signalVersion,
        },
        data: {
          ...success,
          nextPollAt: options.pollImmediately
            ? now
            : new Date(now.getTime() + MAILBOX_RECONCILIATION_INTERVAL_MS),
        },
      });
      if (advanced.count === 1) return ok(true);

      const advancedAfterSignal =
        await this.db.mailboxSubscription.updateMany({
          where: {
            id: claim.subscriptionId,
            status: 'active',
            claimToken: claim.claimToken,
          },
          data: { ...success, nextPollAt: now },
        });
      return ok(advancedAfterSignal.count === 1);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.advanceCursor', cause));
    }
  }

  async signalMailbox(input: {
    mailboxEmail: string;
    historyId: string;
    messageId: string;
    now?: Date;
  }): Promise<Result<number, InfraError>> {
    const now = input.now ?? new Date();
    try {
      const updated = await this.db.mailboxSubscription.updateMany({
        where: {
          mailboxEmail: {
            equals: input.mailboxEmail.trim().toLowerCase(),
            mode: 'insensitive',
          },
          status: 'active',
        },
        data: {
          nextPollAt: now,
          signalVersion: { increment: 1 },
          lastSignalAt: now,
          lastSignalHistoryId: input.historyId,
          lastSignalMessageId: input.messageId,
        },
      });
      return ok(updated.count);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.signalMailbox', cause));
    }
  }

  async claimNextWatchRenewal(
    now = new Date(),
  ): Promise<Result<MailboxWatchClaim | null, InfraError>> {
    const staleBefore = new Date(now.getTime() - MAILBOX_CLAIM_STALE_AFTER_MS);
    try {
      for (
        let attempt = 0;
        attempt < MAIL_CLAIM_CONTENTION_ATTEMPTS;
        attempt++
      ) {
        const due = await this.db.mailboxSubscription.findFirst({
          where: {
            status: 'active',
            nextWatchRenewalAt: { lte: now },
            OR: [
              { watchClaimToken: null },
              { watchClaimedAt: null },
              { watchClaimedAt: { lt: staleBefore } },
            ],
          },
          orderBy: [{ nextWatchRenewalAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            companyId: true,
            userId: true,
            connectionId: true,
            mailboxEmail: true,
            nextWatchRenewalAt: true,
          },
        });
        if (!due) return ok(null);
        const claimToken = randomUUID();
        const claimed = await this.db.mailboxSubscription.updateMany({
          where: {
            id: due.id,
            status: 'active',
            nextWatchRenewalAt: due.nextWatchRenewalAt,
            OR: [
              { watchClaimToken: null },
              { watchClaimedAt: null },
              { watchClaimedAt: { lt: staleBefore } },
            ],
          },
          data: { watchClaimToken: claimToken, watchClaimedAt: now },
        });
        if (claimed.count !== 1) continue;
        return ok({
          subscriptionId: due.id,
          companyId: due.companyId,
          userId: due.userId,
          connectionId: due.connectionId,
          mailboxEmail: due.mailboxEmail,
          claimToken,
        });
      }
      return ok(null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.claimNextWatchRenewal', cause));
    }
  }

  async completeWatchRenewal(
    claim: MailboxWatchClaim,
    historyId: string,
    expiration: Date,
    now = new Date(),
  ): Promise<Result<boolean, InfraError>> {
    try {
      const count = await this.db.$transaction(async tx => {
        const current = await tx.mailboxSubscription.findUnique({
          where: { id: claim.subscriptionId },
          select: { historyId: true },
        });
        const updated = await tx.mailboxSubscription.updateMany({
          where: {
            id: claim.subscriptionId,
            status: 'active',
            watchClaimToken: claim.claimToken,
          },
          data: {
            ...(!current?.historyId ? { historyId } : {}),
            watchExpirationAt: expiration,
            nextWatchRenewalAt: new Date(
              now.getTime() + MAILBOX_WATCH_RENEWAL_INTERVAL_MS,
            ),
            watchRegisteredAt: now,
            watchClaimToken: null,
            watchClaimedAt: null,
            watchFailureCode: null,
            watchFailureCount: 0,
          },
        });
        return updated.count;
      });
      return ok(count === 1);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.completeWatchRenewal', cause));
    }
  }

  async failWatchRenewal(
    claim: MailboxWatchClaim,
    failureCode: string,
    now = new Date(),
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailboxSubscription.updateMany({
        where: {
          id: claim.subscriptionId,
          status: 'active',
          watchClaimToken: claim.claimToken,
        },
        data: {
          watchClaimToken: null,
          watchClaimedAt: null,
          nextWatchRenewalAt: new Date(now.getTime() + 15 * 60_000),
          watchFailureCode: failureCode.slice(0, 120),
          watchFailureCount: { increment: 1 },
        },
      });
      return ok(updated.count === 1);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.failWatchRenewal', cause));
    }
  }

  async markSyncFailed(
    claim: MailboxSyncClaim,
    failureCode: string,
    cause: unknown,
    retryAt: Date,
    now = new Date(),
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailboxSubscription.updateMany({
        where: {
          id: claim.subscriptionId,
          status: 'active',
          claimToken: claim.claimToken,
        },
        data: {
          claimToken: null,
          claimedAt: null,
          nextPollAt: retryAt,
          lastFailedAt: now,
          failureCode: failureCode.slice(0, 120),
          lastError: errorText(cause),
        },
      });
      return ok(updated.count === 1);
    } catch (error) {
      return err(wrapInfra('prisma', 'mailOps.markSyncFailed', error));
    }
  }

  /**
   * Brings every one of this member's mailboxes forward to be polled now.
   *
   * The safety net had no handle on it: a mailbox that failed is scheduled for
   * its own retry, and until that lands there was no way for anybody — the
   * owner, an operator watching it fail — to say "try again now". The only
   * options were to wait out the interval or to edit a row by hand.
   *
   * It moves the schedule and nothing else. It does not clear a failure code,
   * because whether the failure is over is the next pass's answer to give, not
   * this one's; and it will not wake a paused mailbox, because paused is a
   * decision somebody made and this is not the way to reverse it.
   */
  async requestReconciliation(input: {
    companyId: string;
    userId: string;
    now?: Date;
  }): Promise<Result<number, InfraError>> {
    const now = input.now ?? new Date();
    try {
      const updated = await this.db.mailboxSubscription.updateMany({
        where: {
          companyId: input.companyId,
          userId: input.userId,
          status: 'active',
        },
        data: { nextPollAt: now },
      });
      return ok(updated.count);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.requestReconciliation', cause));
    }
  }

  /**
   * Records that a mailbox's cursor was rejected and had to be recovered.
   *
   * A recovery means mail was missed and swept back in by date rather than by
   * history, and `truncated` marks the case where the window held more than one
   * pass reads — the only place in this system where mail is knowingly lost.
   * A log line was the sole record of that, and a log line is not something
   * anybody can query a month later when asked what happened to a message.
   *
   * Best effort by design: this is evidence about a sync, not part of one, and
   * failing a mailbox's whole pass because the audit insert failed would turn a
   * recovered mailbox into a stopped one.
   */
  async recordReconciliation(input: {
    companyId: string;
    subscriptionId: string;
    recoveredCount: number;
    truncated: boolean;
  }): Promise<Result<boolean, InfraError>> {
    try {
      await this.db.mailboxReconciliation.create({
        data: {
          companyId: input.companyId,
          subscriptionId: input.subscriptionId,
          recoveredCount: input.recoveredCount,
          truncated: input.truncated,
        },
        select: { id: true },
      });
      return ok(true);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.recordReconciliation', cause));
    }
  }

  /**
   * Records the mailbox state the owner was last told about.
   *
   * Written after the notification is sent, never before: if delivery fails we
   * would rather risk a duplicate alert on the next pass than silently swallow
   * the only warning a member gets that their rules have stopped.
   */
  async recordNotifiedMailboxState(
    subscriptionId: string,
    state: string,
    now = new Date(),
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailboxSubscription.updateMany({
        where: { id: subscriptionId },
        data: { notifiedState: state, notifiedStateAt: now },
      });
      return ok(updated.count === 1);
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'mailOps.recordNotifiedMailboxState', cause),
      );
    }
  }
}
