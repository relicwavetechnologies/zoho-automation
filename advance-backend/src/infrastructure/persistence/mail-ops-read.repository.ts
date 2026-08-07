/**
 * Read-side persistence for Mail Ops.
 *
 * Everything Mail Ops knows about its own failures currently lands in columns
 * and log lines nothing reads, so a rule can be dead for weeks while the tool
 * still reports it active. This repository exists to make that state
 * answerable. It is strictly read-only — no claims, no cursor movement, no
 * status writes — so it can never interfere with the worker's optimistic
 * concurrency.
 *
 * Kept separate from `mail-ops.repository.ts` rather than added to it: that
 * file already carries four aggregates across 800 lines, and the read model
 * has a genuinely different shape (joins and derived health, no leases).
 */
import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

type MailOpsReadDb = Pick<
  PrismaClient,
  'mailboxSubscription' | 'mailAutomationRule' | 'mailDelivery' | 'mailEvent'
>;

/** How much recorded mail a dry run replays when the caller does not say. */
export const DEFAULT_DRY_RUN_EVENTS = 50;

/** How far back the per-rule delivery counters look. */
export const RULE_ACTIVITY_WINDOW_DAYS = 30;

/**
 * When a failing watch stops being a delay and starts being a fault.
 *
 * Reconciliation now runs whether or not the watch is healthy, so a failing
 * watch costs latency — up to the reconciliation interval — rather than
 * delivery. Alerting on the first failure would train people to ignore the
 * alert; three consecutive failures is the point at which it is not going to
 * fix itself.
 */
export const WATCH_FAILURES_BEFORE_DEGRADED = 3;

export interface MailRuleActivity {
  ruleId: string;
  name: string;
  status: string;
  mailboxEmail: string;
  connectionId: string;
  departmentId: string | null;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
  createdAt: Date;
  /** Last delivery that actually reached its destination, ever. */
  lastDeliveredAt: Date | null;
  /** Counts over RULE_ACTIVITY_WINDOW_DAYS. */
  deliveredCount: number;
  failingCount: number;
  abandonedCount: number;
  /** Matched, then refused. Recorded rather than dropped, so it can be shown. */
  blockedCount: number;
  /** Most recent terminal failure, so the UI can say why without a second call. */
  lastError: string | null;
  lastErrorAt: Date | null;
  /**
   * When the most recent refusal happened, and in whose words.
   *
   * Separate from `lastError` because the two answer different questions: a
   * refusal is about authority and can be undone, a terminal delivery failure
   * is about the send. Reading a windowed refusal count alone made a rule that
   * had since recovered go on reporting itself blocked.
   */
  lastBlockedAt: Date | null;
  blockedReason: string | null;
}

export interface MailDeliveryRecord {
  deliveryId: string;
  status: string;
  attempts: number;
  ambiguous: boolean;
  lastError: string | null;
  firstAttemptAt: Date;
  deliveredAt: Date | null;
  nextAttemptAt: Date | null;
  providerMessageId: string | null;
  /** Read out of the frozen payload so the row can name the mail it acted on. */
  subject: string | null;
  from: string | null;
}

export interface MailboxHealthRecord {
  subscriptionId: string;
  /** Owner identity, needed to notify. The HTTP layer does not return these. */
  companyId: string;
  userId: string;
  mailboxEmail: string;
  status: string;
  connectionId: string;
  hasHistoryCursor: boolean;
  watchRegisteredAt: Date | null;
  watchExpirationAt: Date | null;
  watchFailureCode: string | null;
  /** Consecutive failures, reset by a successful registration. */
  watchFailureCount: number;
  lastSignalAt: Date | null;
  lastSyncAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  failureCode: string | null;
  lastError: string | null;
  activeRuleCount: number;
  totalRuleCount: number;
  /** Last state the owner was notified about, so we alert once per transition. */
  notifiedState: string | null;
}

export class MailOpsReadRepository {
  constructor(private readonly db: MailOpsReadDb) {}

  /**
   * Rules owned by this member, each with enough delivery history to answer
   * "is this working?" without a second round trip per rule.
   */
  async listRuleActivity(input: {
    companyId: string;
    userId: string;
    includeInactive: boolean;
    now?: Date;
  }): Promise<Result<MailRuleActivity[], InfraError>> {
    const since = new Date(
      (input.now ?? new Date()).getTime()
      - RULE_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60_000,
    );
    try {
      const rules = await this.db.mailAutomationRule.findMany({
        where: {
          companyId: input.companyId,
          createdByUserId: input.userId,
          ...(input.includeInactive ? {} : { status: 'active' }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          status: true,
          departmentId: true,
          matchJson: true,
          actionJson: true,
          destinationJson: true,
          createdAt: true,
          subscription: { select: { mailboxEmail: true, connectionId: true } },
        },
      });
      if (rules.length === 0) return ok([]);

      const ruleIds = rules.map(rule => rule.id);
      const [windowed, lastDelivered, lastFailure, lastBlocked] = await Promise.all([
        this.db.mailDelivery.groupBy({
          by: ['ruleId', 'status'],
          where: { ruleId: { in: ruleIds }, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.db.mailDelivery.findMany({
          where: { ruleId: { in: ruleIds }, status: 'delivered' },
          orderBy: [{ deliveredAt: 'desc' }],
          distinct: ['ruleId'],
          select: { ruleId: true, deliveredAt: true },
        }),
        this.db.mailDelivery.findMany({
          where: {
            ruleId: { in: ruleIds },
            status: 'abandoned',
            lastError: { not: null },
          },
          orderBy: [{ updatedAt: 'desc' }],
          distinct: ['ruleId'],
          select: { ruleId: true, lastError: true, updatedAt: true },
        }),
        this.db.mailDelivery.findMany({
          where: { ruleId: { in: ruleIds }, status: 'blocked' },
          orderBy: [{ createdAt: 'desc' }],
          distinct: ['ruleId'],
          select: { ruleId: true, lastError: true, createdAt: true },
        }),
      ]);

      const counts = new Map<string, Map<string, number>>();
      for (const row of windowed) {
        const byStatus = counts.get(row.ruleId) ?? new Map<string, number>();
        byStatus.set(row.status, row._count._all);
        counts.set(row.ruleId, byStatus);
      }
      const deliveredAt = new Map(
        lastDelivered.map(row => [row.ruleId, row.deliveredAt]),
      );
      const failures = new Map(
        lastFailure.map(row => [
          row.ruleId,
          { lastError: row.lastError, at: row.updatedAt },
        ]),
      );
      const refusals = new Map(
        lastBlocked.map(row => [
          row.ruleId,
          { reason: row.lastError, at: row.createdAt },
        ]),
      );

      return ok(rules.map(rule => {
        const byStatus = counts.get(rule.id);
        const failure = failures.get(rule.id);
        const refusal = refusals.get(rule.id);
        return {
          ruleId: rule.id,
          name: rule.name,
          status: rule.status,
          mailboxEmail: rule.subscription.mailboxEmail,
          connectionId: rule.subscription.connectionId,
          departmentId: rule.departmentId,
          match: rule.matchJson as Record<string, unknown>,
          action: rule.actionJson as Record<string, unknown>,
          destination: rule.destinationJson as Record<string, unknown>,
          createdAt: rule.createdAt,
          lastDeliveredAt: deliveredAt.get(rule.id) ?? null,
          deliveredCount: byStatus?.get('delivered') ?? 0,
          failingCount:
            (byStatus?.get('pending') ?? 0) + (byStatus?.get('sending') ?? 0),
          abandonedCount: byStatus?.get('abandoned') ?? 0,
          blockedCount: byStatus?.get('blocked') ?? 0,
          lastError: failure?.lastError ?? null,
          lastErrorAt: failure?.at ?? null,
          lastBlockedAt: refusal?.at ?? null,
          blockedReason: refusal?.reason ?? null,
        };
      }));
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOpsRead.listRuleActivity', cause));
    }
  }

  /**
   * Recent deliveries for one rule. Ownership is enforced in the same query
   * rather than by a prior lookup, so there is no window where a caller could
   * read another member's history.
   */
  async listDeliveriesForRule(input: {
    companyId: string;
    userId: string;
    ruleId: string;
    limit: number;
  }): Promise<Result<MailDeliveryRecord[] | null, InfraError>> {
    try {
      const rule = await this.db.mailAutomationRule.findFirst({
        where: {
          id: input.ruleId,
          companyId: input.companyId,
          createdByUserId: input.userId,
        },
        select: { id: true },
      });
      if (!rule) return ok(null);

      const rows = await this.db.mailDelivery.findMany({
        where: { ruleId: input.ruleId, companyId: input.companyId },
        orderBy: [{ firstAttemptAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: {
          id: true,
          status: true,
          attempts: true,
          ambiguous: true,
          lastError: true,
          firstAttemptAt: true,
          deliveredAt: true,
          nextAttemptAt: true,
          providerMessageId: true,
          payloadJson: true,
        },
      });

      return ok(rows.map(row => {
        const message = readPayloadMessage(row.payloadJson);
        return {
          deliveryId: row.id,
          status: row.status,
          attempts: row.attempts,
          ambiguous: row.ambiguous,
          lastError: row.lastError,
          firstAttemptAt: row.firstAttemptAt,
          deliveredAt: row.deliveredAt,
          nextAttemptAt: row.nextAttemptAt,
          providerMessageId: row.providerMessageId,
          subject: message.subject,
          from: message.from,
        };
      }));
    } catch (cause) {
      return err(
        wrapInfra('prisma', 'mailOpsRead.listDeliveriesForRule', cause),
      );
    }
  }

  /**
   * One rule and the recent mail on its mailbox, for a dry run.
   *
   * The events are the mailbox's, not the rule's: the point is to replay the
   * rule over mail it may never have touched, so filtering to what it already
   * delivered would answer a question nobody asked. Newest first, because a
   * member checking a rule wants to know about this morning.
   *
   * `null` means the rule is not this member's, or does not exist — the query
   * pins ownership, so the two are deliberately indistinguishable.
   */
  async loadRuleForDryRun(input: {
    companyId: string;
    userId: string;
    ruleId: string;
    limit: number;
  }): Promise<Result<{
    ruleId: string;
    name: string;
    status: string;
    mailboxEmail: string;
    match: Record<string, unknown>;
    action: Record<string, unknown>;
    destination: Record<string, unknown>;
    activatedAt: Date;
    events: Array<{
      eventId: string;
      occurredAt: Date;
      metadata: Record<string, unknown>;
    }>;
  } | null, InfraError>> {
    try {
      const rule = await this.db.mailAutomationRule.findFirst({
        where: {
          id: input.ruleId,
          companyId: input.companyId,
          createdByUserId: input.userId,
        },
        select: {
          id: true,
          name: true,
          status: true,
          subscriptionId: true,
          matchJson: true,
          actionJson: true,
          destinationJson: true,
          activatedAt: true,
          subscription: { select: { mailboxEmail: true } },
        },
      });
      if (!rule) return ok(null);

      const events = await this.db.mailEvent.findMany({
        where: {
          subscriptionId: rule.subscriptionId,
          companyId: input.companyId,
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: { id: true, occurredAt: true, metadataJson: true },
      });

      return ok({
        ruleId: rule.id,
        name: rule.name,
        status: rule.status,
        mailboxEmail: rule.subscription.mailboxEmail,
        match: (rule.matchJson ?? {}) as Record<string, unknown>,
        action: (rule.actionJson ?? {}) as Record<string, unknown>,
        destination: (rule.destinationJson ?? {}) as Record<string, unknown>,
        activatedAt: rule.activatedAt,
        events: events.map(event => ({
          eventId: event.id,
          occurredAt: event.occurredAt,
          metadata: (event.metadataJson ?? {}) as Record<string, unknown>,
        })),
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOpsRead.loadRuleForDryRun', cause));
    }
  }

  /**
   * Mailbox-level health. This is the layer that answers "why did everything
   * stop", which no per-rule view can: a mailbox whose watch never registered
   * takes every rule on it down at once.
   */
  async listMailboxHealth(input: {
    companyId: string;
    userId: string;
  }): Promise<Result<MailboxHealthRecord[], InfraError>> {
    return this.readMailboxHealth({
      companyId: input.companyId,
      userId: input.userId,
    });
  }

  /**
   * Recent mail for one of this member's mailboxes, for the correspondent
   * summary behind the rule builder's suggestions.
   *
   * Scoped by `userId` through the subscription, so this can only ever read
   * the caller's own mail — the same pinning every other read here uses, and
   * the reason there is no userId parameter on the route.
   *
   * Only `metadataJson` is selected, and the caller keeps nothing but counted
   * addresses. Bodies are in that column too; pulling a thousand of them to
   * count senders would be an expensive way to read somebody's mail for no
   * purpose, so the row cap is deliberately modest.
   */
  async listRecentEventsForMailbox(input: {
    companyId: string;
    userId: string;
    connectionId?: string;
    limit: number;
  }): Promise<Result<{
    mailboxEmail: string;
    events: Array<{ metadata: Record<string, unknown> }>;
  } | null, InfraError>> {
    try {
      const subscription = await this.db.mailboxSubscription.findFirst({
        where: {
          companyId: input.companyId,
          userId: input.userId,
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, mailboxEmail: true },
      });
      // Not an error. A mailbox with no subscription is simply one Divo has
      // never watched, which is the ordinary state before a first rule.
      if (!subscription) return ok(null);

      const events = await this.db.mailEvent.findMany({
        where: { subscriptionId: subscription.id, companyId: input.companyId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: { metadataJson: true },
      });

      return ok({
        mailboxEmail: subscription.mailboxEmail,
        events: events.map(event => ({
          metadata: (event.metadataJson ?? {}) as Record<string, unknown>,
        })),
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOpsRead.listRecentEventsForMailbox', cause));
    }
  }

  /**
   * One mailbox by ID, for the worker's post-operation health review. Returns
   * null when the subscription has been removed mid-flight.
   */
  async getMailboxHealth(
    subscriptionId: string,
  ): Promise<Result<MailboxHealthRecord | null, InfraError>> {
    const found = await this.readMailboxHealth({ id: subscriptionId });
    if (!found.ok) return found;
    return ok(found.value[0] ?? null);
  }

  private async readMailboxHealth(
    where: { companyId: string; userId: string } | { id: string },
  ): Promise<Result<MailboxHealthRecord[], InfraError>> {
    try {
      const subscriptions = await this.db.mailboxSubscription.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          companyId: true,
          userId: true,
          mailboxEmail: true,
          status: true,
          connectionId: true,
          historyId: true,
          watchRegisteredAt: true,
          watchExpirationAt: true,
          watchFailureCode: true,
          watchFailureCount: true,
          lastSignalAt: true,
          lastSyncAt: true,
          lastSucceededAt: true,
          lastFailedAt: true,
          failureCode: true,
          lastError: true,
          notifiedState: true,
          rules: { select: { status: true } },
        },
      });

      return ok(subscriptions.map(subscription => ({
        subscriptionId: subscription.id,
        companyId: subscription.companyId,
        userId: subscription.userId,
        mailboxEmail: subscription.mailboxEmail,
        status: subscription.status,
        connectionId: subscription.connectionId,
        hasHistoryCursor: Boolean(subscription.historyId),
        watchRegisteredAt: subscription.watchRegisteredAt,
        watchExpirationAt: subscription.watchExpirationAt,
        watchFailureCode: subscription.watchFailureCode,
        watchFailureCount: subscription.watchFailureCount,
        lastSignalAt: subscription.lastSignalAt,
        lastSyncAt: subscription.lastSyncAt,
        lastSucceededAt: subscription.lastSucceededAt,
        lastFailedAt: subscription.lastFailedAt,
        failureCode: subscription.failureCode,
        lastError: subscription.lastError,
        activeRuleCount: subscription.rules.filter(
          rule => rule.status === 'active',
        ).length,
        totalRuleCount: subscription.rules.length,
        notifiedState: subscription.notifiedState,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOpsRead.readMailboxHealth', cause));
    }
  }
}

/**
 * The delivery payload is a frozen snapshot written by the worker, so it is the
 * only place a delivery row can name the message it acted on. It is read
 * defensively: a payload written by an older build must degrade to "unknown"
 * rather than break the whole history view.
 */
function readPayloadMessage(payload: unknown): {
  subject: string | null;
  from: string | null;
} {
  if (!payload || typeof payload !== 'object') {
    return { subject: null, from: null };
  }
  const message = (payload as Record<string, unknown>)['message'];
  if (!message || typeof message !== 'object') {
    return { subject: null, from: null };
  }
  const fields = message as Record<string, unknown>;
  return {
    subject: typeof fields['subject'] === 'string' ? fields['subject'] : null,
    from: typeof fields['from'] === 'string' ? fields['from'] : null,
  };
}
