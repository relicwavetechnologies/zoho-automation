import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import {
  MAILBOX_CLAIM_STALE_AFTER_MS,
  MAILBOX_RECONCILIATION_INTERVAL_MS,
  mailDeliveryIdempotencyKey,
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

export class MailOpsRepository {
  constructor(private readonly db: MailOpsDb) {}

  async createRuleForMailbox(
    input: CreateMailAutomationRuleInput,
  ): Promise<Result<{ ruleId: string; subscriptionId: string }, InfraError>> {
    try {
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
          update: {
            name: input.name,
            status: 'active',
            pausedAt: null,
            archivedAt: null,
          },
          select: { id: true },
        });
        return { ruleId: rule.id, subscriptionId: subscription.id };
      });
      return ok(created);
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.createRuleForMailbox', cause));
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
  }): Promise<Result<boolean, InfraError>> {
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
          select: { id: true, subscriptionId: true },
        });
        if (!current) return false;
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
        return true;
      });
      return ok(changed);
    } catch (cause) {
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
          },
        });
        const activeRules = await tx.mailAutomationRule.count({
          where: { subscriptionId: current.subscriptionId, status: 'active' },
        });
        await tx.mailboxSubscription.update({
          where: { id: current.subscriptionId },
          data: activeRules > 0
            ? {
                status: 'active',
                nextPollAt: now,
                nextWatchRenewalAt: now,
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

  async claimNextDueMailbox(
    now = new Date(),
    requireRegisteredWatch = false,
  ): Promise<Result<MailboxSyncClaim | null, InfraError>> {
    const staleBefore = new Date(
      now.getTime() - MAILBOX_CLAIM_STALE_AFTER_MS,
    );
    try {
      const due = await this.db.mailboxSubscription.findFirst({
        where: {
          status: 'active',
          nextPollAt: { lte: now },
          ...(requireRegisteredWatch
            ? {
                historyId: { not: null },
                watchRegisteredAt: { not: null },
              }
            : {}),
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

  async advanceCursor(
    claim: MailboxSyncClaim,
    nextHistoryId: string,
    now = new Date(),
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
          nextPollAt: new Date(
            now.getTime() + MAILBOX_RECONCILIATION_INTERVAL_MS,
          ),
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
            equals: input.mailboxEmail.trim().toLocaleLowerCase(),
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

  async listActiveRules(
    subscriptionId: string,
  ): Promise<Result<Array<{
    ruleId: string;
    departmentId?: string;
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
          matchJson: true,
          actionJson: true,
          destinationJson: true,
        },
      });
      return ok(rules.map(rule => ({
        ruleId: rule.id,
        ...(rule.departmentId ? { departmentId: rule.departmentId } : {}),
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

  async claimNextDueDelivery(
    now = new Date(),
  ): Promise<Result<ClaimedMailDelivery | null, InfraError>> {
    try {
      await this.db.mailDelivery.updateMany({
        where: {
          status: 'sending',
          startedAt: {
            lt: new Date(now.getTime() - MAILBOX_CLAIM_STALE_AFTER_MS),
          },
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
        select: { id: true, attempts: true, nextAttemptAt: true, payloadJson: true },
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
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'mailOps.claimNextDueDelivery', cause));
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
  ): Promise<Result<boolean, InfraError>> {
    const abandoned = attempts >= 5;
    const backoffMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
    try {
      const updated = await this.db.mailDelivery.updateMany({
        where: { id: deliveryId, status: 'sending', attempts },
        data: {
          status: abandoned ? 'abandoned' : 'pending',
          lastError: errorText(cause),
          nextAttemptAt: abandoned ? null : new Date(now.getTime() + backoffMs),
        },
      });
      return ok(updated.count === 1);
    } catch (error) {
      return err(wrapInfra('prisma', 'mailOps.markDeliveryFailed', error));
    }
  }

  async markDeliveryAbandoned(
    deliveryId: string,
    attempts: number,
    reason: string,
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.mailDelivery.updateMany({
        where: { id: deliveryId, status: 'sending', attempts },
        data: {
          status: 'abandoned',
          lastError: reason.slice(0, 500),
          nextAttemptAt: null,
        },
      });
      return ok(updated.count === 1);
    } catch (error) {
      return err(wrapInfra('prisma', 'mailOps.markDeliveryAbandoned', error));
    }
  }
}
