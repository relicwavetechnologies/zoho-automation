import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

export interface AcceptIngressReceiptInput {
  channel: string;
  tenantKey: string;
  eventId?: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export interface AcceptedIngressReceipt {
  receiptId: string;
  isNew: boolean;
}

export interface IngressReceipt {
  receiptId: string;
  tenantKey: string;
  messageId: string;
  payload: Record<string, unknown>;
}

export interface IngressReceiptRepoPort {
  accept(
    input: AcceptIngressReceiptInput,
  ): Promise<Result<AcceptedIngressReceipt, InfraError>>;
  markQueued(receiptId: string, queueJobId: string): Promise<Result<void, InfraError>>;
  claim(receiptId: string): Promise<Result<IngressReceipt | null, InfraError>>;
  markCompleted(receiptId: string): Promise<Result<void, InfraError>>;
  markFailed(receiptId: string, error: unknown): Promise<Result<void, InfraError>>;
  listRecoverable(limit: number): Promise<Result<string[], InfraError>>;
}

export class IngressReceiptRepository implements IngressReceiptRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async accept(
    input: AcceptIngressReceiptInput,
  ): Promise<Result<AcceptedIngressReceipt, InfraError>> {
    try {
      const row = await this.db.ingressIdempotencyKey.create({
        data: {
          channel: input.channel,
          tenantKey: input.tenantKey,
          messageId: input.messageId,
          payloadJson: input.payload as Prisma.InputJsonObject,
          ...(input.eventId ? { eventId: input.eventId } : {}),
        },
        select: { id: true },
      });
      return ok({ receiptId: row.id, isNew: true });
    } catch (cause) {
      if ((cause as { code?: string }).code === 'P2002') {
        try {
          const existing = await this.db.ingressIdempotencyKey.findUnique({
            where: {
              channel_tenantKey_messageId: {
                channel: input.channel,
                tenantKey: input.tenantKey,
                messageId: input.messageId,
              },
            },
            select: { id: true },
          });
          if (existing) {
            return ok({ receiptId: existing.id, isNew: false });
          }
        } catch (lookupCause) {
          return err(wrapInfra('prisma', 'ingressReceipt.findDuplicate', lookupCause));
        }
      }
      return err(wrapInfra('prisma', 'ingressReceipt.accept', cause));
    }
  }

  async markQueued(receiptId: string, queueJobId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.ingressIdempotencyKey.update({
        where: { id: receiptId },
        data: { queueJobId },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.markQueued', cause));
    }
  }

  async claim(receiptId: string): Promise<Result<IngressReceipt | null, InfraError>> {
    try {
      const claimed = await this.db.ingressIdempotencyKey.updateMany({
        where: {
          id: receiptId,
          status: { not: 'completed' },
        },
        data: {
          status: 'processing',
          attempts: { increment: 1 },
          startedAt: new Date(),
          lastError: null,
        },
      });
      if (claimed.count === 0) return ok(null);

      const row = await this.db.ingressIdempotencyKey.findUnique({
        where: { id: receiptId },
        select: {
          id: true,
          tenantKey: true,
          messageId: true,
          payloadJson: true,
        },
      });
      if (!row) return ok(null);
      return ok({
        receiptId: row.id,
        tenantKey: row.tenantKey,
        messageId: row.messageId,
        payload: row.payloadJson as Record<string, unknown>,
      });
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.claim', cause));
    }
  }

  async markCompleted(receiptId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.ingressIdempotencyKey.update({
        where: { id: receiptId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          lastError: null,
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.markCompleted', cause));
    }
  }

  async markFailed(receiptId: string, error: unknown): Promise<Result<void, InfraError>> {
    try {
      await this.db.ingressIdempotencyKey.updateMany({
        where: {
          id: receiptId,
          status: { not: 'completed' },
        },
        data: {
          status: 'failed',
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.markFailed', cause));
    }
  }

  async listRecoverable(limit: number): Promise<Result<string[], InfraError>> {
    try {
      const rows = await this.db.ingressIdempotencyKey.findMany({
        where: {
          channel: 'lark',
          status: { in: ['accepted', 'processing', 'failed'] },
        },
        orderBy: { acceptedAt: 'asc' },
        take: limit,
        select: { id: true },
      });
      return ok(rows.map(row => row.id));
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.listRecoverable', cause));
    }
  }
}
