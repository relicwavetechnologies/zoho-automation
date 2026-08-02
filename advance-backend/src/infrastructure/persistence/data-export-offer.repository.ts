import type { Prisma, PrismaClient } from '../../generated/prisma';
import type {
  ClaimDataExportOfferResult,
  CreateDataExportOfferInput,
  CreateDataExportOfferResult,
  DataExportOfferRecord,
  DataExportOfferRepositoryPort,
  DataExportOfferStatus,
  LoadDataExportOfferResult,
} from '../../application/data-export/export-offer';
import { parseDataExportOfferPayload } from '../../application/data-export/export-offer';
import { wrapInfra } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

type DataExportOfferDb = Pick<PrismaClient, 'dataExportOffer'>;

const CONFIRMATION_LEASE_MS = 60_000;

const offerSelect = {
  id: true,
  companyId: true,
  userId: true,
  departmentId: true,
  sourceKind: true,
  sourceConnectionId: true,
  payloadJson: true,
  specHash: true,
  idempotencyKey: true,
  status: true,
  queueJobId: true,
  expiresAt: true,
  confirmedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type OfferRow = {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId: string | null;
  readonly sourceKind: string;
  readonly sourceConnectionId: string;
  readonly payloadJson: Prisma.JsonValue;
  readonly specHash: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly queueJobId: string | null;
  readonly expiresAt: Date;
  readonly confirmedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export class DataExportOfferRepository implements DataExportOfferRepositoryPort {
  constructor(private readonly db: DataExportOfferDb) {}

  async create(
    input: CreateDataExportOfferInput,
  ): Promise<Result<CreateDataExportOfferResult, Error>> {
    try {
      const offer = await this.db.dataExportOffer.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          sourceKind: input.sourceKind,
          sourceConnectionId: input.sourceConnectionId,
          payloadJson: input.payload as unknown as Prisma.InputJsonValue,
          specHash: input.specHash,
          idempotencyKey: input.idempotencyKey,
          expiresAt: input.expiresAt,
        },
        select: offerSelect,
      });
      return ok({ outcome: 'created', offer: toRecord(offer) });
    } catch (cause) {
      if ((cause as { code?: string }).code === 'P2002') {
        try {
          const existing = await this.db.dataExportOffer.findUnique({
            where: {
              companyId_idempotencyKey: {
                companyId: input.companyId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            select: offerSelect,
          });
          if (existing && existing.expiresAt.getTime() > input.now.getTime()) {
            return ok({ outcome: 'existing', offer: toRecord(existing) });
          }
          if (existing) {
            const deleted = await this.db.dataExportOffer.deleteMany({
              where: {
                id: existing.id,
                companyId: input.companyId,
                expiresAt: { lte: input.now },
              },
            });
            if (deleted.count === 1) return this.create(input);
          }
          const replacement = await this.db.dataExportOffer.findUnique({
            where: {
              companyId_idempotencyKey: {
                companyId: input.companyId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            select: offerSelect,
          });
          if (replacement) return ok({ outcome: 'existing', offer: toRecord(replacement) });
          return this.create(input);
        } catch (lookupCause) {
          return err(wrapInfra('prisma', 'dataExportOffer.findDuplicate', lookupCause));
        }
      }
      return err(wrapInfra('prisma', 'dataExportOffer.create', cause));
    }
  }

  async loadForConfirmation(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly now?: Date;
  }): Promise<Result<LoadDataExportOfferResult, Error>> {
    const now = input.now ?? new Date();
    try {
      const offer = await this.findForActor(input);
      if (!offer || offer.status === 'cancelled') return ok({ outcome: 'not_found' });
      if (offer.status === 'expired' || offer.expiresAt.getTime() <= now.getTime()) {
        await this.deleteExpiredForActor(offer, input, now);
        return ok({ outcome: 'expired' });
      }
      return ok({ outcome: 'found', offer });
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportOffer.loadForConfirmation', cause));
    }
  }

  async claimConfirmation(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly now?: Date;
  }): Promise<Result<ClaimDataExportOfferResult, Error>> {
    const now = input.now ?? new Date();
    try {
      const claimed = await this.db.dataExportOffer.updateMany({
        where: {
          id: input.offerId,
          companyId: input.companyId,
          userId: input.userId,
          status: 'pending',
          expiresAt: { gt: now },
        },
        data: { status: 'confirming', updatedAt: now },
      });
      const offer = await this.findForActor(input);
      if (!offer) return ok({ outcome: 'not_found' });
      if (offer.status === 'expired' || offer.expiresAt.getTime() <= now.getTime()) {
        await this.deleteExpiredForActor(offer, input, now);
        return ok({ outcome: 'expired' });
      }
      if (claimed.count === 1) {
        return ok({ outcome: 'claimed', offer });
      }
      if (offer.status === 'confirmed' && offer.queueJobId) {
        return ok({
          outcome: 'already_confirmed',
          offer,
          queueJobId: offer.queueJobId,
        });
      }
      if (offer.status === 'confirming') {
        const reclaimed = await this.db.dataExportOffer.updateMany({
          where: {
            id: input.offerId,
            companyId: input.companyId,
            userId: input.userId,
            status: 'confirming',
            updatedAt: { lte: new Date(now.getTime() - CONFIRMATION_LEASE_MS) },
          },
          data: { updatedAt: now },
        });
        if (reclaimed.count === 1) {
          const reclaimedOffer = await this.findForActor(input);
          return reclaimedOffer
            ? ok({ outcome: 'claimed', offer: reclaimedOffer })
            : ok({ outcome: 'not_found' });
        }
        return ok({ outcome: 'in_progress', offer });
      }
      return ok({ outcome: 'not_found' });
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportOffer.claimConfirmation', cause));
    }
  }

  async markConfirmed(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly queueJobId: string;
    readonly confirmedAt?: Date;
  }): Promise<Result<boolean, Error>> {
    try {
      const confirmedAt = input.confirmedAt ?? new Date();
      const updated = await this.db.dataExportOffer.updateMany({
        where: {
          id: input.offerId,
          companyId: input.companyId,
          userId: input.userId,
          status: 'confirming',
        },
        data: {
          status: 'confirmed',
          queueJobId: input.queueJobId,
          confirmedAt,
        },
      });
      if (updated.count === 1) return ok(true);
      const existing = await this.findForActor(input);
      return ok(existing?.status === 'confirmed' && existing.queueJobId === input.queueJobId);
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportOffer.markConfirmed', cause));
    }
  }

  private async findForActor(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
  }): Promise<DataExportOfferRecord | null> {
    const row = await this.db.dataExportOffer.findFirst({
      where: {
        id: input.offerId,
        companyId: input.companyId,
        userId: input.userId,
      },
      select: offerSelect,
    });
    return row ? toRecord(row) : null;
  }

  private async deleteExpiredForActor(
    offer: DataExportOfferRecord,
    input: { readonly companyId: string; readonly userId: string },
    now: Date,
  ): Promise<void> {
    await this.db.dataExportOffer.deleteMany({
      where: {
        id: offer.id,
        companyId: input.companyId,
        userId: input.userId,
        OR: [
          { status: 'expired' },
          { expiresAt: { lte: now } },
        ],
      },
    });
  }
}

function toRecord(row: OfferRow): DataExportOfferRecord {
  const payload = parseDataExportOfferPayload(row.payloadJson);
  const status = parseStatus(row.status);
  if (row.sourceKind !== payload.source.kind) {
    throw new Error('Data export offer source kind does not match its immutable payload');
  }
  if (row.sourceConnectionId !== payload.source.connectionId) {
    throw new Error('Data export offer connection does not match its immutable payload');
  }
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    ...(row.departmentId ? { departmentId: row.departmentId } : {}),
    sourceKind: payload.source.kind,
    sourceConnectionId: row.sourceConnectionId,
    payload,
    specHash: row.specHash,
    idempotencyKey: row.idempotencyKey,
    status,
    ...(row.queueJobId ? { queueJobId: row.queueJobId } : {}),
    expiresAt: row.expiresAt,
    ...(row.confirmedAt ? { confirmedAt: row.confirmedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseStatus(value: string): DataExportOfferStatus {
  switch (value) {
    case 'pending':
    case 'confirming':
    case 'confirmed':
    case 'expired':
    case 'cancelled':
      return value;
    default:
      throw new Error(`Unknown data export offer status: ${value}`);
  }
}
