import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type { DeliveryPurpose } from '../../domain/channel/delivery-key';

export interface ReserveDeliveryInput {
  channel: string;
  idempotencyKey: string;
  runKey: string;
  purpose: DeliveryPurpose;
  segmentIndex?: number;
  companyId?: string;
  chatId?: string;
  /**
   * The rendered reply. Stored so a delivery that failed after the agent
   * finished can be resent without re-running the tools that produced it —
   * repeating a completed side effect merely to resend an answer is the thing
   * Wave 5 exists to stop.
   */
  payload?: Record<string, unknown>;
}

export interface DeliveryRecord {
  deliveryId: string;
  /** Monotonic claim generation; a stale sender cannot settle a newer claim. */
  claimAttempt: number;
  attempts: number;
  firstAttemptAt: Date;
  providerMessageId?: string;
}

/**
 * What a reservation found.
 *
 * `delivered` is the case the whole model exists for: a retry discovering that
 * this exact segment already reached the user. Returning it as a distinct
 * outcome — rather than as a null the caller is free to read as "go ahead" —
 * is what stops a resend becoming a second reply.
 *
 * `inFlight` means another attempt holds the lease and has not been silent long
 * enough to be presumed dead. `abandoned` means delivery was given up on.
 */
export type DeliveryReservation =
  | { outcome: 'reserved'; record: DeliveryRecord }
  | { outcome: 'delivered'; record: DeliveryRecord }
  | { outcome: 'inFlight' }
  | { outcome: 'abandoned' };

export interface ReserveDeliveryOptions {
  /** A `sending` row is only re-claimable once its owner has gone this quiet. */
  staleSendingAfterMs?: number;
}

export interface MarkDeliveryFailedOptions {
  /** The claim generation that owns this state transition. */
  claimAttempt?: number;
  /** Stop retrying: either a terminal provider error or the budget is spent. */
  terminal?: boolean;
  /**
   * The send may or may not have reached Lark. Recorded because a resend is
   * then a judgement call rather than an obvious retry, and an operator
   * deserves to know which of the two they are looking at.
   */
  ambiguous?: boolean;
  /** When the next attempt becomes eligible. Backoff is computed by the caller. */
  nextAttemptAt?: Date;
}

export type DeliveryClaimSettlement = 'applied' | 'superseded';

export interface ResumableDelivery {
  deliveryId: string;
  purpose: DeliveryPurpose;
  segmentIndex: number;
  attempts: number;
  firstAttemptAt: Date;
  payload: Record<string, unknown>;
}

export interface ChannelDeliveryRepoPort {
  reserve(
    input: ReserveDeliveryInput,
    options?: ReserveDeliveryOptions,
  ): Promise<Result<DeliveryReservation, InfraError>>;
  markDelivered(
    deliveryId: string,
    providerMessageId: string | undefined,
    claimAttempt?: number,
  ): Promise<Result<DeliveryClaimSettlement, InfraError>>;
  markFailed(
    deliveryId: string,
    error: unknown,
    options?: MarkDeliveryFailedOptions,
  ): Promise<Result<DeliveryClaimSettlement, InfraError>>;
  listRetryable(
    limit: number,
    options?: { channel?: string; now?: Date },
  ): Promise<Result<string[], InfraError>>;
  /**
   * An undelivered reply this run already produced, if there is one.
   *
   * Consulted before re-running an agent so a retry caused only by a delivery
   * failure resends the finished answer instead of recomputing it.
   */
  findResumable(
    channel: string,
    runKey: string,
  ): Promise<Result<ResumableDelivery | null, InfraError>>;
}

const DEFAULT_STALE_SENDING_MS = 60_000;

/** Terminal in the sense that no further attempt should be made. */
const TERMINAL_STATUSES = ['delivered', 'abandoned'] as const;
const RETRYABLE_STATUSES = ['pending', 'sending', 'failed'] as const;

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

export class ChannelDeliveryRepository implements ChannelDeliveryRepoPort {
  constructor(private readonly db: Pick<PrismaClient, 'channelDelivery'>) {}

  /**
   * Claim the right to send one segment, creating the record if this is the
   * first attempt.
   *
   * Create-then-claim rather than upsert-then-read, because the interesting
   * case is the second caller: it must be told the segment is already delivered
   * instead of quietly proceeding.
   */
  async reserve(
    input: ReserveDeliveryInput,
    options?: ReserveDeliveryOptions,
  ): Promise<Result<DeliveryReservation, InfraError>> {
    const staleBefore = new Date(
      Date.now() - (options?.staleSendingAfterMs ?? DEFAULT_STALE_SENDING_MS),
    );

    try {
      const existing = await this.db.channelDelivery.findUnique({
        where: {
          channel_idempotencyKey: {
            channel: input.channel,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: {
          id: true,
          status: true,
          attempts: true,
          firstAttemptAt: true,
          providerMessageId: true,
        },
      });

      if (!existing) {
        try {
          const created = await this.db.channelDelivery.create({
            data: {
              channel: input.channel,
              idempotencyKey: input.idempotencyKey,
              runKey: input.runKey,
              purpose: input.purpose,
              segmentIndex: input.segmentIndex ?? 0,
              status: 'sending',
              attempts: 1,
              startedAt: new Date(),
              ...(input.payload ? { payloadJson: input.payload as Prisma.InputJsonObject } : {}),
              ...(input.companyId ? { companyId: input.companyId } : {}),
              ...(input.chatId ? { chatId: input.chatId } : {}),
            },
            select: { id: true, attempts: true, firstAttemptAt: true },
          });
          return ok({
            outcome: 'reserved',
            record: {
              deliveryId: created.id,
              claimAttempt: created.attempts,
              attempts: created.attempts,
              firstAttemptAt: created.firstAttemptAt,
            },
          });
        } catch (cause) {
          // Two first attempts raced and the other one created the row. This is
          // the case the unique constraint exists to catch, so surfacing it as
          // an error would be self-defeating: the caller treats a broken guard
          // as licence to send unguarded, and both attempts would deliver.
          if ((cause as { code?: string }).code !== 'P2002') throw cause;
          const winner = await this.readRow(input);
          if (!winner) throw cause;
          return this.claimExisting(winner, staleBefore);
        }
      }

      return this.claimExisting(existing, staleBefore);
    } catch (e) {
      return err(wrapInfra('prisma', 'channelDelivery.reserve', e));
    }
  }

  private async readRow(input: ReserveDeliveryInput) {
    return this.db.channelDelivery.findUnique({
      where: {
        channel_idempotencyKey: {
          channel: input.channel,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: {
        id: true,
        status: true,
        attempts: true,
        firstAttemptAt: true,
        providerMessageId: true,
      },
    });
  }

  /**
   * Decide what a caller may do with a row that already exists.
   *
   * Shared between the ordinary path and the lost-the-create-race path so both
   * reach the same verdict — a race that resolved differently from a retry
   * would be a duplicate reply waiting to happen.
   */
  private async claimExisting(
    existing: {
      id: string;
      status: string;
      attempts: number;
      firstAttemptAt: Date;
      providerMessageId: string | null;
    },
    staleBefore: Date,
  ): Promise<Result<DeliveryReservation, InfraError>> {
    if (existing.status === 'delivered') {
      return ok({
        outcome: 'delivered',
          record: {
            deliveryId: existing.id,
            claimAttempt: existing.attempts,
            attempts: existing.attempts,
          firstAttemptAt: existing.firstAttemptAt,
          ...(existing.providerMessageId
            ? { providerMessageId: existing.providerMessageId }
            : {}),
        },
      });
    }
    if (existing.status === 'abandoned') return ok({ outcome: 'abandoned' });

    // Conditional claim. The predicate is the lease: a row someone else is
    // actively sending is only takeable once they have gone quiet, and the
    // status guard closes the race with a concurrent markDelivered.
    const claimed = await this.db.channelDelivery.updateMany({
      where: {
        id: existing.id,
        status: { notIn: [...TERMINAL_STATUSES] },
        OR: [
          { status: { not: 'sending' } },
          { startedAt: null },
          { startedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: 'sending',
        attempts: { increment: 1 },
        startedAt: new Date(),
        lastError: null,
      },
    });

    if (claimed.count === 0) {
      // Lost the race. Re-read rather than guess: the winner may have
      // delivered it, in which case the caller must not send at all.
      const current = await this.db.channelDelivery.findUnique({
        where: { id: existing.id },
        select: {
          id: true,
          status: true,
          attempts: true,
          firstAttemptAt: true,
          providerMessageId: true,
        },
      });
      if (current?.status === 'delivered') {
        return ok({
          outcome: 'delivered',
          record: {
            deliveryId: current.id,
            claimAttempt: current.attempts,
            attempts: current.attempts,
            firstAttemptAt: current.firstAttemptAt,
            ...(current.providerMessageId
              ? { providerMessageId: current.providerMessageId }
              : {}),
          },
        });
      }
      if (current?.status === 'abandoned') return ok({ outcome: 'abandoned' });
      return ok({ outcome: 'inFlight' });
    }

    return ok({
      outcome: 'reserved',
      record: {
        deliveryId: existing.id,
        claimAttempt: existing.attempts + 1,
        attempts: existing.attempts + 1,
        firstAttemptAt: existing.firstAttemptAt,
      },
    });
  }

  async markDelivered(
    deliveryId: string,
    providerMessageId: string | undefined,
    claimAttempt?: number,
  ): Promise<Result<DeliveryClaimSettlement, InfraError>> {
    try {
      const updated = await this.db.channelDelivery.updateMany({
        // `abandoned` is deliberately overwritable: if a send that was given up
        // on turns out to have landed, the truth is that it was delivered.
        where: claimAttempt === undefined
          ? { id: deliveryId, status: { not: 'delivered' } }
          : { id: deliveryId, status: 'sending', attempts: claimAttempt },
        data: {
          status: 'delivered',
          deliveredAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
          ambiguous: false,
          // The stored copy exists to enable a resend. Once the user has the
          // answer, keeping it is retention without a purpose.
          payloadJson: Prisma.DbNull,
          ...(providerMessageId ? { providerMessageId } : {}),
        },
      });
      return ok(updated.count === 1 ? 'applied' : 'superseded');
    } catch (e) {
      return err(wrapInfra('prisma', 'channelDelivery.markDelivered', e));
    }
  }

  async markFailed(
    deliveryId: string,
    error: unknown,
    options?: MarkDeliveryFailedOptions,
  ): Promise<Result<DeliveryClaimSettlement, InfraError>> {
    try {
      const updated = await this.db.channelDelivery.updateMany({
        where: options?.claimAttempt === undefined
          ? options?.terminal
          // A delivered row must never be walked back by a late failure from an
          // earlier attempt; anything else may be abandoned.
            ? { id: deliveryId, status: { not: 'delivered' } }
            : { id: deliveryId, status: { notIn: [...TERMINAL_STATUSES] } }
          : { id: deliveryId, status: 'sending', attempts: options.claimAttempt },
        data: {
          status: options?.terminal ? 'abandoned' : 'failed',
          lastError: errorText(error),
          ...(options?.ambiguous !== undefined ? { ambiguous: options.ambiguous } : {}),
          ...(options?.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
        },
      });
      return ok(updated.count === 1 ? 'applied' : 'superseded');
    } catch (e) {
      return err(wrapInfra('prisma', 'channelDelivery.markFailed', e));
    }
  }

  async findResumable(
    channel: string,
    runKey: string,
  ): Promise<Result<ResumableDelivery | null, InfraError>> {
    try {
      const row = await this.db.channelDelivery.findFirst({
        where: {
          channel,
          runKey,
          status: { in: [...RETRYABLE_STATUSES] },
          // Only rows that actually carry a resendable reply.
          payloadJson: { not: Prisma.DbNull },
        },
        orderBy: [{ purpose: 'asc' }, { segmentIndex: 'asc' }],
        select: {
          id: true,
          purpose: true,
          segmentIndex: true,
          attempts: true,
          firstAttemptAt: true,
          payloadJson: true,
        },
      });
      if (!row || row.payloadJson === null) return ok(null);
      return ok({
        deliveryId: row.id,
        purpose: row.purpose as DeliveryPurpose,
        segmentIndex: row.segmentIndex,
        attempts: row.attempts,
        firstAttemptAt: row.firstAttemptAt,
        payload: row.payloadJson as Record<string, unknown>,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'channelDelivery.findResumable', e));
    }
  }

  /** Deliveries eligible for another attempt now. Ordered oldest-first. */
  async listRetryable(
    limit: number,
    options?: { channel?: string; now?: Date },
  ): Promise<Result<string[], InfraError>> {
    const now = options?.now ?? new Date();
    try {
      const rows = await this.db.channelDelivery.findMany({
        where: {
          ...(options?.channel ? { channel: options.channel } : {}),
          status: { in: [...RETRYABLE_STATUSES] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { firstAttemptAt: 'asc' },
        take: limit,
        select: { id: true },
      });
      return ok(rows.map(row => row.id));
    } catch (e) {
      return err(wrapInfra('prisma', 'channelDelivery.listRetryable', e));
    }
  }
}
