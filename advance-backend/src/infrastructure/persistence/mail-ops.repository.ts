import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import {
  MAILBOX_CLAIM_STALE_AFTER_MS,
  MAILBOX_RECONCILIATION_INTERVAL_MS,
  mailDeliveryIdempotencyKey,
  mailRuleDedupeKey,
  type MailRuleAction,
  type MailRuleDestination,
  type MailRuleMatch,
  type NewMailEvent,
} from '../../application/mail-ops/mail-ops.types';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

type MailOpsDb = Pick<
  PrismaClient,
  | 'mailboxSubscription'
  | 'mailAutomationRule'
  | 'mailEvent'
  | 'mailDelivery'
  | '$transaction'
>;

export interface MailboxSyncClaim {
  subscriptionId: string;
  companyId: string;
  userId: string;
  connectionId: string;
  mailboxEmail: string;
  historyId?: string;
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
 * What became of a replace. `duplicate` is its own answer rather than a
 * failure: the rule the member asked for exists, it is just not the row they
 * named.
 */
export type MailRuleReplacement =
  | 'replaced'
  | 'not_found'
  | 'duplicate'
  | 'duplicate_archived';

export interface CreateMailAutomationRuleInput {
  companyId: string;
  createdByUserId: string;
  departmentId?: string;
  name: string;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
  connectionId: string;
  mailboxEmail: string;
  dedupeKey: string;
}

export interface PersistedMailEvent extends NewMailEvent {
  eventId: string;
}

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

export interface MailAutomationRuleSummary {
  ruleId: string;
  name: string;
  status: string;
  mailboxEmail: string;
  connectionId: string;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
  createdAt: Date;
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * Is this stored rule clause the same one the caller is submitting?
 *
 * Neither key order nor letter case is meaning here. Both sides are small JSON
 * objects round-tripped through Postgres and Zod, and every clause is matched
 * case-insensitively (`mailRuleMatches`), so retyping `OTP` as `otp` changes
 * nothing about which mail the rule takes. Scoring that as a change would
 * restart the rule's watch and drop its backlog, which is the harm this
 * comparison exists to prevent.
 *
 * `toLowerCase`, matching the fold used by `mailRuleMatches` and by the rule's
 * stored identity. A locale-sensitive one would leave the three disagreeing:
 * under a Turkish locale a case-only edit would count as a change here, and
 * drop the backlog, while both of the others called it the same rule.
 */
function sameRuleClause(stored: unknown, submitted: unknown): boolean {
  return stableJson(stored) === stableJson(submitted);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (key, inner) => {
    // Except a Lark chat ID, which the rule's identity also leaves alone: two
    // chats whose IDs differ only in case are two chats, and calling that no
    // change would deliver the old destination's backlog into the new one.
    if (key === 'chatId') return inner;
    if (typeof inner === 'string') return inner.toLowerCase();
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      ),
    );
  });
}

export class MailOpsRepository {
  constructor(private readonly db: MailOpsDb) {}

  async createRuleForMailbox(
    input: CreateMailAutomationRuleInput,
  ): Promise<Result<{ ruleId: string; subscriptionId: string }, InfraError>> {
    try {
      // Ahead of the transaction, not inside it. Postgres aborts a transaction
      // outright on a unique violation, so a swallowed collision there would
      // leave every later statement failing on a dead transaction — the create
      // would report failure for a rule that exists and is watching. On its
      // own it is an idempotent key rename: safe to have committed even if the
      // create that follows does not.
      await this.adoptRuleKeyedBeforeCanonicalisation(input);
      const created = await this.db.$transaction(async tx => {
        const subscription = await tx.mailboxSubscription.upsert({
          where: { connectionId: input.connectionId },
          create: {
            companyId: input.companyId,
            userId: input.createdByUserId,
            connectionId: input.connectionId,
            mailboxEmail: input.mailboxEmail,
          },
          update: {
            mailboxEmail: input.mailboxEmail,
            status: 'active',
            nextPollAt: new Date(),
            nextWatchRenewalAt: new Date(),
            failureCode: null,
            lastError: null,
          },
          select: { id: true },
        });
        const rule = await tx.mailAutomationRule.upsert({
          where: { dedupeKey: input.dedupeKey },
          create: {
            companyId: input.companyId,
            createdByUserId: input.createdByUserId,
            ...(input.departmentId ? { departmentId: input.departmentId } : {}),
            subscriptionId: subscription.id,
            name: input.name,
            matchJson: input.match as Prisma.InputJsonObject,
            actionJson: input.action as Prisma.InputJsonObject,
            destinationJson: input.destination as Prisma.InputJsonObject,
            dedupeKey: input.dedupeKey,
          },
          // Reviving is the conditional write below, not this branch. The
          // dedupe key is derived from the rule's own content, so "ask for the
          // same rule again" lands here just as often as a revive does, and a
          // rule that is already running must keep watching from where it was
          // — moving its floor would silently drop whatever backlog it had not
          // reached, and the member never asked for anything to stop.
          // `actionJson` alongside the name, and only because of
          // `rateLimitPerHour`. Every other field of the action is part of the
          // dedupe key, so landing here proves they already agree — the ceiling
          // is the one thing that can differ, and writing it is what makes
          // "create the same rule but slower" mean anything. Without this the
          // tool reported the new ceiling and the rule kept the old one.
          update: {
            name: input.name,
            actionJson: input.action as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        // Coming back to life and starting a fresh watch are one statement, so
        // a rule can never be revived still carrying a floor from before it
        // stopped. Issued after the upsert on purpose: it is the last thing
        // this transaction does, so it also catches a pause that committed
        // while the transaction was in flight — which the same test placed
        // before the upsert would miss, leaving the rule paused while the tool
        // told the member their automation was on.
        await tx.mailAutomationRule.updateMany({
          where: { id: rule.id, status: { not: 'active' } },
          data: {
            status: 'active',
            pausedAt: null,
            archivedAt: null,
            activatedAt: new Date(),
          },
        });
        return { ruleId: rule.id, subscriptionId: subscription.id };
      });
      return ok(created);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.createRuleForMailbox', cause));
    }
  }

  /**
   * Every rule this member holds on this mailbox, oldest first.
   *
   * Ordered so two requests racing the same decision reach the same one rather
   * than each acting on a different row. Archived rules are included:
   * recreating one is the only way to bring it back, so an archived row that is
   * this rule must be visible here or a revive silently becomes a second rule.
   */
  private async rulesOnMailbox(
    client: Pick<MailOpsDb, 'mailAutomationRule'>,
    input: { companyId: string; connectionId: string; createdByUserId?: string; userId?: string },
  ) {
    return client.mailAutomationRule.findMany({
      where: {
        companyId: input.companyId,
        createdByUserId: input.createdByUserId ?? input.userId!,
        subscription: { connectionId: input.connectionId },
      },
      select: {
        id: true,
        status: true,
        dedupeKey: true,
        matchJson: true,
        actionJson: true,
        destinationJson: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Is this stored rule the one being asked for?
   *
   * Answered from what the row holds, never from the key it carries. Every rule
   * written before canonicalisation carries a key derived by the old formula,
   * and that key cannot be reproduced from a request — so a comparison of
   * stored keys is blind to exactly the rules the migration is about.
   */
  private isSameRule(
    rule: {
      matchJson: unknown;
      actionJson: unknown;
      destinationJson: unknown;
    },
    input: { companyId: string; connectionId: string; dedupeKey: string },
    userId: string,
  ): boolean {
    return mailRuleDedupeKey({
      companyId: input.companyId,
      userId,
      connectionId: input.connectionId,
      match: rule.matchJson as MailRuleMatch,
      action: rule.actionJson as MailRuleAction,
      destination: rule.destinationJson as MailRuleDestination,
    }) === input.dedupeKey;
  }

  /**
   * Move a rule keyed before canonicalisation onto the key its content earns.
   *
   * Without this, canonicalising the key would cause on its first use the exact
   * duplicate it exists to prevent: the upsert below would find nothing, create
   * a second rule beside the one already watching, and both would forward every
   * matching message. Migration happens here, one rule at a time, as each is
   * asked for again — a bulk rewrite of every row on deploy would have to be
   * right about all of them at once.
   *
   * The canonical key is recomputed from what each stored rule holds, rather
   * than the old key being recomputed from the request — the request is the
   * one thing that cannot reproduce the old key. The
   * fork this repairs was a difference of case, so a member asking again in the
   * other case — `otp` where the stored rule says `OTP` — would hash to a third
   * key and match nothing. Comparing what the rules *are* is what makes the
   * migration cover the case that caused the damage.
   *
   * Skipped when a canonical row already exists, because then the two rules
   * genuinely are the fork this fix is about, and renaming one onto the other's
   * key would only fail the unique constraint and take the request with it. The
   * canonical one wins; the other keeps running until someone removes it.
   */
  private async adoptRuleKeyedBeforeCanonicalisation(
    input: CreateMailAutomationRuleInput,
  ): Promise<void> {
    const candidates = await this.rulesOnMailbox(this.db, input);
    if (candidates.some(rule => rule.dedupeKey === input.dedupeKey)) return;
    const sameRule = candidates.filter(
      rule => this.isSameRule(rule, input, input.createdByUserId),
    );
    if (sameRule.length === 0) return;
    // A live rule is preferred when the member already holds the fork this
    // repairs, because the create below revives whatever it lands on: adopting
    // the archived twin would bring a second rule back to life beside the one
    // already forwarding, which is the outcome the whole exercise is against.
    // Anything not archived, not only `active`: a paused rule is one the member
    // intends to resume, and leaving it on the old key while an archived twin
    // is adopted and revived hands them two live rules on two keys, which the
    // unique constraint cannot catch and which forwards every message twice.
    const adopted = sameRule.find(rule => rule.status !== 'archived')
      ?? sameRule[0]!;
    try {
      await this.db.mailAutomationRule.update({
        where: { id: adopted.id },
        data: { dedupeKey: input.dedupeKey },
      });
    } catch (cause) {
      // Another request claimed the canonical key between the scan and here.
      // That rule is this rule, so the create below finds it and there is
      // nothing left to migrate — failing the member's request over a race
      // that already reached the right answer would be the worse outcome.
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError
        && cause.code === 'P2002'
      ) return;
      throw cause;
    }
  }

  async listRulesForUser(input: {
    companyId: string;
    userId: string;
    includeInactive?: boolean;
  }): Promise<Result<MailAutomationRuleSummary[], InfraError>> {
    try {
      const rows = await this.db.mailAutomationRule.findMany({
        where: {
          companyId: input.companyId,
          createdByUserId: input.userId,
          ...(!input.includeInactive ? { status: 'active' } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          status: true,
          matchJson: true,
          actionJson: true,
          destinationJson: true,
          createdAt: true,
          subscription: {
            select: { mailboxEmail: true, connectionId: true },
          },
        },
      });
      return ok(rows.map(row => ({
        ruleId: row.id,
        name: row.name,
        status: row.status,
        mailboxEmail: row.subscription.mailboxEmail,
        connectionId: row.subscription.connectionId,
        match: row.matchJson as Record<string, unknown>,
        action: row.actionJson as Record<string, unknown>,
        destination: row.destinationJson as Record<string, unknown>,
        createdAt: row.createdAt,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.listRulesForUser', cause));
    }
  }

  async replaceRule(input: {
    companyId: string;
    userId: string;
    ruleId: string;
    connectionId: string;
    name: string;
    match: Record<string, unknown>;
    action: Record<string, unknown>;
    destination: Record<string, unknown>;
    dedupeKey: string;
  }): Promise<Result<MailRuleReplacement, InfraError>> {
    try {
      const changed = await this.db.$transaction(async tx => {
        const current = await tx.mailAutomationRule.findFirst({
          where: {
            id: input.ruleId,
            companyId: input.companyId,
            createdByUserId: input.userId,
            status: { not: 'archived' },
            subscription: { connectionId: input.connectionId },
          },
          select: {
            id: true,
            subscriptionId: true,
            status: true,
            matchJson: true,
            actionJson: true,
            destinationJson: true,
          },
        });
        if (!current) return 'not_found' as const;
        // Editing a rule into one this member already holds is a real answer —
        // the rule they are asking for exists — and it is reported rather than
        // left to raise a unique violation inside the transaction and reach
        // them as an infra failure they can do nothing about.
        //
        // Recognised the same way the create path recognises it: by what each
        // stored rule holds, not by the key it carries. Every rule written
        // before the key was canonicalised carries one derived by the old
        // formula, and no request can reproduce that — so a comparison of
        // stored keys is blind to precisely the rules this window is about, and
        // the edit would quietly produce the second active rule, forwarding
        // every matching message twice, that the whole exercise is against.
        const collision = (await this.rulesOnMailbox(tx, input)).find(
          rule => rule.id !== current.id
            && (
              rule.dedupeKey === input.dedupeKey
              || this.isSameRule(rule, input, input.userId)
            ),
        );
        if (collision) {
          // An archived rule holds its key too, and telling the member to
          // archive one of two rules forwarding twice would be untrue: the
          // other forwards nothing. Their way forward is a different one.
          return collision.status === 'archived'
            ? 'duplicate_archived' as const
            : 'duplicate' as const;
        }
        // The tool's `update` takes the whole rule, so renaming one resubmits
        // its existing match and destination. That is the same rule watching
        // the same address, and moving its floor would quietly drop whatever
        // backlog it had not reached — a stalled cursor is exactly when
        // somebody tidies up a rule's name. The floor moves when the rule
        // stopped, or when what it watches or where it sends actually changed.
        const restarting = current.status !== 'active'
          || !sameRuleClause(current.matchJson, input.match)
          || !sameRuleClause(current.actionJson, input.action)
          || !sameRuleClause(current.destinationJson, input.destination);
        await tx.mailAutomationRule.update({
          where: { id: current.id },
          data: {
            name: input.name,
            matchJson: input.match as Prisma.InputJsonObject,
            actionJson: input.action as Prisma.InputJsonObject,
            destinationJson: input.destination as Prisma.InputJsonObject,
            dedupeKey: input.dedupeKey,
            status: 'active',
            pausedAt: null,
            version: { increment: 1 },
            // A replace can move the destination or widen the match. Mail that
            // arrived under the old ones was never this version of the rule's
            // to send, so it starts watching now.
            ...(restarting ? { activatedAt: new Date() } : {}),
          },
        });
        await tx.mailboxSubscription.update({
          where: { id: current.subscriptionId },
          data: {
            status: 'active',
            nextPollAt: new Date(),
            nextWatchRenewalAt: new Date(),
          },
        });
        return 'replaced' as const;
      });
      return ok(changed);
    } catch (cause) {
      // The check above narrows the window rather than closing it: another
      // request can claim the key between the two statements. Same answer.
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError
        && cause.code === 'P2002'
      ) return ok('duplicate');
      return err(wrapInfra('prisma', 'mailOps.replaceRule', cause));
    }
  }

  async setRuleStatus(input: {
    companyId: string;
    userId: string;
    ruleId: string;
    status: 'active' | 'paused' | 'archived';
    now?: Date;
  }): Promise<Result<boolean, InfraError>> {
    const now = input.now ?? new Date();
    try {
      const changed = await this.db.$transaction(async tx => {
        const current = await tx.mailAutomationRule.findFirst({
          where: {
            id: input.ruleId,
            companyId: input.companyId,
            createdByUserId: input.userId,
          },
          select: { id: true, subscriptionId: true, status: true },
        });
        if (!current) return false;
        if (current.status === input.status) return true;
        if (current.status === 'archived') return false;
        await tx.mailAutomationRule.update({
          where: { id: current.id },
          data: {
            status: input.status,
            pausedAt: input.status === 'paused' ? now : null,
            archivedAt: input.status === 'archived' ? now : null,
            // Resuming is not a licence to deliver the pause. "Paused" was
            // sold to the member as "stop forwarding", so the mail that
            // arrived meanwhile is not this rule's to send.
            ...(input.status === 'active' ? { activatedAt: now } : {}),
          },
        });
        const activeRules = await tx.mailAutomationRule.count({
          where: { subscriptionId: current.subscriptionId, status: 'active' },
        });
        // A paused rule is meant to be resumable, and pausing the mailbox
        // underneath it made that untrue in both directions. A paused
        // subscription is claimed neither for sync nor for watch renewal, so
        // the cursor stood still; past Gmail's history retention the resume
        // 404s into recovery, which loses the intervening days outright *and*
        // replays up to a day of already-read mail through the freshly resumed
        // rule. Keeping the mailbox live costs a poll nobody needs and keeps
        // "paused" meaning what the member was told it means.
        const livingRules = await tx.mailAutomationRule.count({
          where: {
            subscriptionId: current.subscriptionId,
            status: { not: 'archived' },
          },
        });
        await tx.mailboxSubscription.update({
          where: { id: current.subscriptionId },
          data: livingRules > 0
            ? {
                status: 'active',
                // Only chase the mailbox immediately when something can
                // actually fire; otherwise let it keep its ordinary cadence.
                ...(activeRules > 0
                  ? { nextPollAt: now, nextWatchRenewalAt: now }
                  : {}),
              }
            : { status: 'paused' },
        });
        return true;
      });
      return ok(changed);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.setRuleStatus', cause));
    }
  }

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
          nextPollAt: true,
          signalVersion: true,
        },
      });
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
      if (claimed.count !== 1) return ok(null);

      return ok({
        subscriptionId: due.id,
        companyId: due.companyId,
        userId: due.userId,
        connectionId: due.connectionId,
        mailboxEmail: due.mailboxEmail,
        ...(due.historyId ? { historyId: due.historyId } : {}),
        signalVersion: due.signalVersion,
        claimToken,
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.claimNextDueMailbox', cause));
    }
  }

  async recordEvents(
    claim: MailboxSyncClaim,
    events: NewMailEvent[],
  ): Promise<Result<PersistedMailEvent[], InfraError>> {
    try {
      const persisted = await this.db.$transaction(async tx => {
        if (events.length > 0) {
          await tx.mailEvent.createMany({
            data: events.map(event => ({
              companyId: claim.companyId,
              subscriptionId: claim.subscriptionId,
              providerMessageId: event.providerMessageId,
              ...(event.providerThreadId
                ? { providerThreadId: event.providerThreadId }
                : {}),
              historyId: event.historyId,
              metadataJson: event.metadata as Prisma.InputJsonObject,
              occurredAt: event.occurredAt,
            })),
            skipDuplicates: true,
          });
        }
        if (events.length === 0) return [];

        const rows = await tx.mailEvent.findMany({
          where: {
            subscriptionId: claim.subscriptionId,
            providerMessageId: {
              in: events.map(event => event.providerMessageId),
            },
          },
          select: {
            id: true,
            providerMessageId: true,
            providerThreadId: true,
            historyId: true,
            metadataJson: true,
            occurredAt: true,
          },
        });
        return rows.map(row => ({
          eventId: row.id,
          providerMessageId: row.providerMessageId,
          ...(row.providerThreadId
            ? { providerThreadId: row.providerThreadId }
            : {}),
          historyId: row.historyId,
          metadata: row.metadataJson as Record<string, unknown>,
          occurredAt: row.occurredAt,
        }));
      });
      return ok(persisted);
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'mailOps.recordEvents', cause),
      );
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
    options: { pollImmediately?: boolean } = {},
  ): Promise<Result<boolean, InfraError>> {
    const success = {
      historyId: nextHistoryId,
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
      if (claimed.count !== 1) return ok(null);
      return ok({
        subscriptionId: due.id,
        companyId: due.companyId,
        userId: due.userId,
        connectionId: due.connectionId,
        mailboxEmail: due.mailboxEmail,
        claimToken,
      });
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
            nextWatchRenewalAt: new Date(now.getTime() + 24 * 60 * 60_000),
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

  async listActiveRules(
    subscriptionId: string,
  ): Promise<Result<Array<{
    ruleId: string;
    departmentId?: string;
    activatedAt: Date;
    match: Record<string, unknown>;
    action: Record<string, unknown>;
    destination: Record<string, unknown>;
  }>, InfraError>> {
    try {
      const rules = await this.db.mailAutomationRule.findMany({
        where: { subscriptionId, status: 'active' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          departmentId: true,
          activatedAt: true,
          matchJson: true,
          actionJson: true,
          destinationJson: true,
        },
      });
      return ok(rules.map(rule => ({
        ruleId: rule.id,
        ...(rule.departmentId ? { departmentId: rule.departmentId } : {}),
        activatedAt: rule.activatedAt,
        match: rule.matchJson as Record<string, unknown>,
        action: rule.actionJson as Record<string, unknown>,
        destination: rule.destinationJson as Record<string, unknown>,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.listActiveRules', cause));
    }
  }

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
   * Counted from `firstAttemptAt`, which is stamped when the delivery is
   * reserved. A retry an hour later does not consume a second slot — the mail
   * only leaves once.
   */
  async countRecentDeliveries(input: {
    ruleId: string;
    since: Date;
  }): Promise<Result<number, InfraError>> {
    try {
      return ok(await this.db.mailDelivery.count({
        where: {
          ruleId: input.ruleId,
          firstAttemptAt: { gte: input.since },
          status: { notIn: ['blocked', 'abandoned'] },
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
      // at five. Returning such a row to `pending` stranded it there for the
      // life of the table — never claimed, never abandoned, and still wearing
      // whatever `ambiguous` said about it. `ambiguous` is left exactly as it
      // was, because a process that died during a send genuinely did not
      // establish whether the mail went out.
      await this.db.mailDelivery.updateMany({
        where: {
          status: 'sending',
          startedAt: { lt: staleBefore },
          attempts: { gte: 5 },
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
          attempts: { lt: 5 },
        },
        data: { status: 'pending', nextAttemptAt: now },
      });
      const due = await this.db.mailDelivery.findFirst({
        where: {
          status: 'pending',
          attempts: { lt: 5 },
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
    const abandoned = attempts >= 5;
    const backoffMs = 5_000 * 2 ** Math.max(0, attempts - 1);
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
}
