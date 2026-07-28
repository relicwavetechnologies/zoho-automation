import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

export interface AcceptIngressReceiptInput {
  channel: string;
  tenantKey: string;
  companyId?: string;
  eventId?: string;
  messageId: string;
  payload: Record<string, unknown>;
  /** Execution lane, recorded so a burst in one lane can be found cheaply. */
  laneKey?: string;
}

/** A receipt still waiting in a lane, as seen by the run that may absorb it. */
export interface PendingLaneReceipt {
  receiptId: string;
  messageId: string;
  payload: Record<string, unknown>;
  acceptedAt: Date;
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
  /** Company that owned the tenant when this event was admitted. */
  companyId?: string;
  /** Immutable execution lane chosen when the event was admitted. */
  laneKey?: string;
  /** Attempt number of this claim, starting at 1. Recorded for observability. */
  attempts: number;
  /** When Lark's delivery was durably accepted. Owns the dead-letter decision. */
  acceptedAt: Date;
}

/**
 * Why a claim did not produce work. The two cases must stay distinguishable:
 * `terminal` means the receipt is finished and the job may complete, whereas
 * `leased` means someone else is mid-run and this job must be retried later.
 * Collapsing them into a single null lets the queue complete a job whose work
 * never happened, which permanently closes the recovery path for that receipt.
 */
export type IngressClaim =
  | { outcome: 'claimed'; receipt: IngressReceipt }
  | { outcome: 'leased' }
  | { outcome: 'terminal' };

export interface ClaimIngressReceiptOptions {
  /**
   * A `processing` receipt is only re-claimable once its owner has been silent
   * this long. Without it a reconcile pass can hand live work to a second
   * worker, which is the failure the durable receipt exists to prevent.
   */
  staleProcessingAfterMs?: number;
}

export interface MarkIngressFailedOptions {
  /** Terminal failures move to `dead` so recovery stops retrying them forever. */
  terminal?: boolean;
}

export interface ListRecoverableOptions {
  channel?: string;
  /** Mirrors the claim lease so retirement cannot race a live worker. */
  staleProcessingAfterMs?: number;
  /**
   * How long after acceptance a receipt stays retryable. A budget counted in
   * attempts instead of time is exhausted by whatever retries fastest — the
   * queue's own in-job attempts burn it in seconds — which turns a short
   * provider outage into a permanent drop. Time is the property that actually
   * distinguishes a transient failure from a poison payload.
   */
  retryWindowMs?: number;
}

export interface IngressReceiptRepoPort {
  accept(
    input: AcceptIngressReceiptInput,
  ): Promise<Result<AcceptedIngressReceipt, InfraError>>;
  markQueued(receiptId: string, queueJobId: string): Promise<Result<void, InfraError>>;
  claim(
    receiptId: string,
    options?: ClaimIngressReceiptOptions,
  ): Promise<Result<IngressClaim, InfraError>>;
  markCompleted(receiptId: string): Promise<Result<void, InfraError>>;
  markFailed(
    receiptId: string,
    error: unknown,
    options?: MarkIngressFailedOptions,
  ): Promise<Result<void, InfraError>>;
  listRecoverable(
    limit: number,
    options?: ListRecoverableOptions,
  ): Promise<Result<string[], InfraError>>;
  /**
   * Non-terminal receipts whose retry window has closed. These are past saving
   * by retry — including ones stranded in `processing` by a worker that was
   * killed — and must be moved to `dead` so they stop being invisible.
   */
  listExhausted(
    limit: number,
    options?: ListRecoverableOptions,
  ): Promise<Result<string[], InfraError>>;
  listBatchable(
    laneKey: string,
    options: { channel?: string; excludeReceiptId: string; limit: number },
  ): Promise<Result<PendingLaneReceipt[], InfraError>>;
}

/** Statuses that must never be re-claimed or re-queued by recovery. */
const TERMINAL_INGRESS_STATUSES = ['completed', 'dead'] as const;
const RECOVERABLE_INGRESS_STATUSES = ['accepted', 'processing', 'failed'] as const;
const DEFAULT_STALE_PROCESSING_MS = 5 * 60_000;
const DEFAULT_RETRY_WINDOW_MS = 6 * 60 * 60_000;

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
          ...(input.companyId ? { companyId: input.companyId } : {}),
          ...(input.eventId ? { eventId: input.eventId } : {}),
          ...(input.laneKey ? { laneKey: input.laneKey } : {}),
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

  async claim(
    receiptId: string,
    options: ClaimIngressReceiptOptions = {},
  ): Promise<Result<IngressClaim, InfraError>> {
    const staleBefore = new Date(
      Date.now() - (options.staleProcessingAfterMs ?? DEFAULT_STALE_PROCESSING_MS),
    );
    try {
      // A claim is a lease, not a status stamp: a receipt another worker is
      // actively processing stays with that worker until its lease goes stale.
      const claimed = await this.db.ingressIdempotencyKey.updateMany({
        where: {
          id: receiptId,
          status: { notIn: [...TERMINAL_INGRESS_STATUSES] },
          OR: [
            { status: { not: 'processing' } },
            { startedAt: null },
            { startedAt: { lt: staleBefore } },
          ],
        },
        data: {
          status: 'processing',
          attempts: { increment: 1 },
          startedAt: new Date(),
          lastError: null,
        },
      });
      if (claimed.count === 0) {
        // Nothing was claimed for one of two reasons. Re-read the status so the
        // caller can tell "already finished" from "someone else is running it".
        const current = await this.db.ingressIdempotencyKey.findUnique({
          where: { id: receiptId },
          select: { status: true },
        });
        const terminal = !current
          || (TERMINAL_INGRESS_STATUSES as readonly string[]).includes(current.status);
        return ok({ outcome: terminal ? 'terminal' : 'leased' });
      }

      const row = await this.db.ingressIdempotencyKey.findUnique({
        where: { id: receiptId },
        select: {
          id: true,
          tenantKey: true,
          messageId: true,
          payloadJson: true,
          companyId: true,
          laneKey: true,
          attempts: true,
          acceptedAt: true,
        },
      });
      if (!row) return ok({ outcome: 'terminal' });
      return ok({
        outcome: 'claimed',
        receipt: {
          receiptId: row.id,
          tenantKey: row.tenantKey,
          messageId: row.messageId,
          payload: row.payloadJson as Record<string, unknown>,
          ...(row.companyId ? { companyId: row.companyId } : {}),
          ...(row.laneKey ? { laneKey: row.laneKey } : {}),
          attempts: row.attempts,
          acceptedAt: row.acceptedAt,
        },
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

  async markFailed(
    receiptId: string,
    error: unknown,
    options: MarkIngressFailedOptions = {},
  ): Promise<Result<void, InfraError>> {
    try {
      await this.db.ingressIdempotencyKey.updateMany({
        where: {
          id: receiptId,
          // A retryable failure must not resurrect an already dead-lettered
          // receipt; only a terminal write may overwrite `dead`.
          status: options.terminal
            ? { not: 'completed' }
            : { notIn: [...TERMINAL_INGRESS_STATUSES] },
        },
        data: {
          status: options.terminal ? 'dead' : 'failed',
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      return ok(undefined);
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.markFailed', cause));
    }
  }

  /**
   * Other messages waiting in the same lane, oldest first.
   *
   * Only `accepted` rows are returned: a `processing` receipt has an owner and
   * a `failed` one is mid-retry, and absorbing either would answer a message
   * that something else is still responsible for. The caller must still claim
   * each one before merging it — this read only narrows the field.
   */
  async listBatchable(
    laneKey: string,
    options: { channel?: string; excludeReceiptId: string; limit: number },
  ): Promise<Result<PendingLaneReceipt[], InfraError>> {
    try {
      const rows = await this.db.ingressIdempotencyKey.findMany({
        where: {
          channel: options.channel ?? 'lark',
          laneKey,
          status: 'accepted',
          id: { not: options.excludeReceiptId },
        },
        orderBy: { acceptedAt: 'asc' },
        take: options.limit,
        select: { id: true, messageId: true, payloadJson: true, acceptedAt: true },
      });
      return ok(rows.map(row => ({
        receiptId: row.id,
        messageId: row.messageId,
        payload: (row.payloadJson ?? {}) as Record<string, unknown>,
        acceptedAt: row.acceptedAt,
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.listBatchable', cause));
    }
  }

  async listRecoverable(
    limit: number,
    options: ListRecoverableOptions = {},
  ): Promise<Result<string[], InfraError>> {
    try {
      const rows = await this.db.ingressIdempotencyKey.findMany({
        where: {
          channel: options.channel ?? 'lark',
          status: { in: [...RECOVERABLE_INGRESS_STATUSES] },
          // Receipts past their window stay inspectable but must never hold a
          // recovery slot; otherwise the oldest poison rows, which sort first,
          // starve live work forever.
          acceptedAt: { gte: this.retryFloor(options) },
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

  async listExhausted(
    limit: number,
    options: ListRecoverableOptions = {},
  ): Promise<Result<string[], InfraError>> {
    const staleBefore = new Date(
      Date.now() - (options.staleProcessingAfterMs ?? DEFAULT_STALE_PROCESSING_MS),
    );
    try {
      const rows = await this.db.ingressIdempotencyKey.findMany({
        where: {
          channel: options.channel ?? 'lark',
          status: { in: [...RECOVERABLE_INGRESS_STATUSES] },
          acceptedAt: { lt: this.retryFloor(options) },
          // Never retire a receipt a worker is still running. A long turn that
          // crosses the window boundary would otherwise be logged as dead while
          // it is about to succeed, and its real outcome would overwrite that.
          OR: [
            { status: { not: 'processing' } },
            { startedAt: null },
            { startedAt: { lt: staleBefore } },
          ],
        },
        orderBy: { acceptedAt: 'asc' },
        take: limit,
        select: { id: true },
      });
      return ok(rows.map(row => row.id));
    } catch (cause) {
      return err(wrapInfra('prisma', 'ingressReceipt.listExhausted', cause));
    }
  }

  private retryFloor(options: ListRecoverableOptions): Date {
    return new Date(Date.now() - (options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS));
  }
}
