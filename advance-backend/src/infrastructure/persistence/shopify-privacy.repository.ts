import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, ShopifyPrivacyRequest as PrismaPrivacyRequest } from '../../generated/prisma';
import {
  boundedPrivacyLimit,
  parseShopifyPrivacyExport,
  preparePrivacyLookup,
  prepareRedactionSelectors,
  prepareShopifyPrivacyRequest,
  type CreateShopifyPrivacyRequest,
  type ShopifyPrivacyMutationResult,
  type ShopifyPrivacyDeliveryEvidence,
  type ShopifyPrivacyRepository,
  type ShopifyPrivacyRequestDetail,
  type ShopifyPrivacyRequestSummary,
  type ShopifyPrivacyState,
} from '../../application/shopify/shopify-privacy.lifecycle';
import { decryptToken, encryptToken } from '../shared/token.crypto';
import { err, ok, type Result } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

const AUDIT_ACTOR = 'shopify:privacy-lifecycle';
const EXPIRABLE_STATES: readonly ShopifyPrivacyState[] = ['received', 'ready', 'delivered', 'failed'];
const MAX_COMPANIES_PER_REDACTION = 100;

export class PrismaShopifyPrivacyRepository implements ShopifyPrivacyRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly encryptionKey: string,
  ) {}

  async create(input: CreateShopifyPrivacyRequest): Promise<Result<{
    readonly created: boolean;
    readonly request: ShopifyPrivacyRequestSummary;
  }, InfraError>> {
    try {
      return ok(await this.db.$transaction(tx => this.createInTransaction(tx, input)));
    } catch (cause) {
      if (isUniqueConflict(cause)) return this.retryConcurrentCreate(input);
      return err(wrapInfra('prisma', 'shopifyPrivacy.create', cause));
    }
  }

  /** Used by signed webhook admission so receipt deduplication and lifecycle creation are atomic. */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateShopifyPrivacyRequest,
  ): Promise<{ readonly created: boolean; readonly request: ShopifyPrivacyRequestSummary }> {
    const prepared = prepareShopifyPrivacyRequest(input);
    const encrypted = prepared.serializedExport === null
      ? null
      : encryptToken(prepared.serializedExport, this.encryptionKey);
    const existing = await tx.shopifyPrivacyRequest.findUnique({
      where: {
        companyId_shopDomain_requestId: {
          companyId: prepared.companyId,
          shopDomain: prepared.shopDomain,
          requestId: prepared.requestId,
        },
      },
    });
    if (existing) {
      assertSameSubject(existing, prepared.customerIdHash, prepared.orderIdHashes);
      if (existing.state === 'received' && prepared.state !== 'received') {
        const now = new Date();
        const updated = await tx.shopifyPrivacyRequest.updateMany({
          where: { id: existing.id, companyId: existing.companyId, state: 'received' },
          data: {
            state: prepared.state,
            exportPayloadEncrypted: encrypted?.cipherText ?? null,
            exportCipherVersion: encrypted?.version ?? null,
            failureCode: prepared.failureCode,
            readyAt: prepared.state === 'ready' ? now : null,
          },
        });
        const winner = await tx.shopifyPrivacyRequest.findUniqueOrThrow({ where: { id: existing.id } });
        if (updated.count === 1) await writeAudit(tx, winner.companyId, winner.id, winner.state);
        return { created: false, request: toSummary(winner) };
      }
      return { created: false, request: toSummary(existing) };
    }

    const now = new Date();
    const row = await tx.shopifyPrivacyRequest.create({
      data: {
        companyId: prepared.companyId,
        shopDomain: prepared.shopDomain,
        requestId: prepared.requestId,
        customerIdHash: prepared.customerIdHash,
        orderIdHashes: [...prepared.orderIdHashes],
        state: prepared.state,
        exportPayloadEncrypted: encrypted?.cipherText ?? null,
        exportCipherVersion: encrypted?.version ?? null,
        failureCode: prepared.failureCode,
        deadlineAt: prepared.deadlineAt,
        expiresAt: prepared.expiresAt,
        readyAt: prepared.state === 'ready' ? now : null,
      },
    });
    await writeAudit(tx, row.companyId, row.id, row.state);
    return { created: true, request: toSummary(row) };
  }

  async list(input: {
    readonly companyId: string;
    readonly shopDomain?: string;
    readonly states?: readonly ShopifyPrivacyState[];
    readonly limit?: number;
  }): Promise<Result<readonly ShopifyPrivacyRequestSummary[], InfraError>> {
    try {
      const companyId = requiredCompanyId(input.companyId);
      const shopDomain = input.shopDomain === undefined
        ? undefined
        : preparePrivacyLookup({ companyId, shopDomain: input.shopDomain }).shopDomain;
      const states = input.states === undefined ? undefined : validateStates(input.states);
      const rows = await this.db.shopifyPrivacyRequest.findMany({
        where: {
          companyId,
          ...(shopDomain ? { shopDomain } : {}),
          ...(states ? { state: { in: [...states] } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: boundedPrivacyLimit(input.limit),
      });
      return ok(rows.map(toSummary));
    } catch (cause) {
      return err(wrapInfra('prisma', 'shopifyPrivacy.list', cause));
    }
  }

  async get(input: {
    readonly companyId: string;
    readonly shopDomain: string;
    readonly id: string;
    readonly actorId: string;
  }): Promise<Result<ShopifyPrivacyRequestDetail | null, InfraError>> {
    try {
      const key = preparePrivacyLookup(input);
      const actorId = requiredOpaqueId(input.actorId, 'actorId');
      const found = await this.db.$transaction(async tx => {
        const found = await tx.shopifyPrivacyRequest.findFirst({ where: key });
        if (!found) return null;
        const exportPayload = found.exportPayloadEncrypted
          ? parseShopifyPrivacyExport(decryptToken(found.exportPayloadEncrypted, this.encryptionKey))
          : null;
        await writeAudit(tx, found.companyId, found.id, 'accessed', actorId);
        return { row: found, exportPayload };
      });
      if (!found) return ok(null);
      return ok({ ...toSummary(found.row), exportPayload: found.exportPayload });
    } catch (cause) {
      return err(wrapInfra('prisma', 'shopifyPrivacy.get', cause));
    }
  }

  async markDelivered(input: {
    readonly companyId: string;
    readonly shopDomain: string;
    readonly id: string;
    readonly actorId: string;
    readonly deliveryEvidence: ShopifyPrivacyDeliveryEvidence;
  }): Promise<Result<boolean, InfraError>> {
    try {
      const key = preparePrivacyLookup(input);
      const id = key.id;
      if (!id) throw new Error('id is required.');
      const actorId = requiredOpaqueId(input.actorId, 'actorId');
      const recipient = requiredOpaqueId(input.deliveryEvidence.recipient, 'deliveryEvidence.recipient');
      const receiptId = requiredOpaqueId(input.deliveryEvidence.receiptId, 'deliveryEvidence.receiptId');
      const deliveredAt = input.deliveryEvidence.deliveredAt;
      assertValidTimestamp(deliveredAt, 'deliveredAt');
      const acknowledgedAt = new Date();
      if (deliveredAt.getTime() > acknowledgedAt.getTime()) return ok(false);
      const changed = await this.db.$transaction(async tx => {
        const updated = await tx.shopifyPrivacyRequest.updateMany({
          where: {
            ...key,
            state: 'ready',
            readyAt: { lte: deliveredAt },
            expiresAt: { gt: acknowledgedAt },
          },
          data: { state: 'delivered', deliveredAt },
        });
        if (updated.count !== 1) return false;
        await writeAudit(tx, key.companyId, id, 'delivered', actorId, {
          channel: input.deliveryEvidence.channel,
          recipientHash: hashAuditValue(recipient),
          receiptIdHash: hashAuditValue(receiptId),
          deliveredAt: deliveredAt.toISOString(),
        });
        return true;
      });
      return ok(changed);
    } catch (cause) {
      return err(wrapInfra('prisma', 'shopifyPrivacy.markDelivered', cause));
    }
  }

  async redact(input: {
    readonly companyId: string;
    readonly shopDomain: string;
    readonly requestId?: string;
    readonly customerId?: string;
    readonly orderIds?: readonly string[];
    readonly limit?: number;
  }): Promise<Result<ShopifyPrivacyMutationResult, InfraError>> {
    try {
      return ok(await this.db.$transaction(tx => this.redactInTransaction(tx, input)));
    } catch (cause) {
      return err(wrapInfra('prisma', 'shopifyPrivacy.redact', cause));
    }
  }

  async findRedactionCompanyIdsInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly shopDomain: string;
      readonly requestId?: string;
      readonly customerId?: string;
      readonly orderIds?: readonly string[];
    },
  ): Promise<readonly string[]> {
    const shopDomain = requiredShopDomain(input.shopDomain);
    const selectors = prepareRedactionSelectors(input);
    return this.findCompanyIdsInTransaction(tx, {
      shopDomain,
      state: { not: 'redacted' },
      OR: [
        ...(selectors.requestId ? [{ requestId: selectors.requestId }] : []),
        ...(selectors.customerIdHash ? [{ customerIdHash: selectors.customerIdHash }] : []),
        ...(selectors.orderIdHashes.length > 0 ? [{ orderIdHashes: { hasSome: [...selectors.orderIdHashes] } }] : []),
      ],
    });
  }

  async findShopCompanyIdsInTransaction(
    tx: Prisma.TransactionClient,
    input: { readonly shopDomain: string },
  ): Promise<readonly string[]> {
    return this.findCompanyIdsInTransaction(tx, {
      shopDomain: requiredShopDomain(input.shopDomain),
      state: { not: 'redacted' },
    });
  }

  /** Used by signed customer-redaction admission to share the webhook receipt transaction. */
  async redactInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly companyId: string;
      readonly shopDomain: string;
      readonly requestId?: string;
      readonly customerId?: string;
      readonly orderIds?: readonly string[];
      readonly limit?: number;
    },
  ): Promise<ShopifyPrivacyMutationResult> {
    const key = preparePrivacyLookup(input);
    const selectors = prepareRedactionSelectors(input);
    const where: Prisma.ShopifyPrivacyRequestWhereInput = {
      companyId: key.companyId,
      shopDomain: key.shopDomain,
      state: { not: 'redacted' },
      OR: [
        ...(selectors.requestId ? [{ requestId: selectors.requestId }] : []),
        ...(selectors.customerIdHash ? [{ customerIdHash: selectors.customerIdHash }] : []),
        ...(selectors.orderIdHashes.length > 0 ? [{ orderIdHashes: { hasSome: [...selectors.orderIdHashes] } }] : []),
      ],
    };
    return this.scrubRowsInTransaction(tx, {
      where,
      state: 'redacted',
      at: new Date(),
      limit: boundedPrivacyLimit(input.limit),
    });
  }

  async redactShopInTransaction(
    tx: Prisma.TransactionClient,
    input: { readonly companyId: string; readonly shopDomain: string; readonly limit?: number },
  ): Promise<ShopifyPrivacyMutationResult> {
    const key = preparePrivacyLookup(input);
    return this.scrubRowsInTransaction(tx, {
      where: {
        companyId: key.companyId,
        shopDomain: key.shopDomain,
        state: { not: 'redacted' },
      },
      state: 'redacted',
      at: new Date(),
      limit: boundedPrivacyLimit(input.limit),
    });
  }

  async sweep(input: {
    readonly now?: Date;
    readonly limit?: number;
  } = {}): Promise<Result<ShopifyPrivacyMutationResult, InfraError>> {
    try {
      const now = input.now ?? new Date();
      assertValidTimestamp(now, 'now');
      const where: Prisma.ShopifyPrivacyRequestWhereInput = {
        state: { in: [...EXPIRABLE_STATES] },
        expiresAt: { lte: now },
      };
      return ok(await this.db.$transaction(tx => this.scrubRowsInTransaction(tx, {
        where,
        state: 'expired',
        at: now,
        limit: boundedPrivacyLimit(input.limit),
      })));
    } catch (cause) {
      return err(wrapInfra('prisma', 'shopifyPrivacy.sweep', cause));
    }
  }

  private async scrubRowsInTransaction(tx: Prisma.TransactionClient, input: {
    where: Prisma.ShopifyPrivacyRequestWhereInput;
    state: Extract<ShopifyPrivacyState, 'expired' | 'redacted'>;
    at: Date;
    limit: number;
  }): Promise<ShopifyPrivacyMutationResult> {
    const candidates = await tx.shopifyPrivacyRequest.findMany({
      where: input.where,
      select: { id: true, companyId: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
    });
    const hasMore = candidates.length > input.limit;
    let affected = 0;
    for (const candidate of candidates.slice(0, input.limit)) {
      const updated = await tx.shopifyPrivacyRequest.updateMany({
        where: { id: candidate.id, ...input.where },
        data: {
          state: input.state,
          customerIdHash: null,
          orderIdHashes: [],
          exportPayloadEncrypted: null,
          exportCipherVersion: null,
          failureCode: null,
          ...(input.state === 'redacted' ? { redactedAt: input.at } : {}),
        },
      });
      if (updated.count !== 1) continue;
      affected += 1;
      await writeAudit(tx, candidate.companyId, candidate.id, input.state);
    }
    return { affected, hasMore };
  }

  private async findCompanyIdsInTransaction(
    tx: Prisma.TransactionClient,
    where: Prisma.ShopifyPrivacyRequestWhereInput,
  ): Promise<readonly string[]> {
    const rows = await tx.shopifyPrivacyRequest.findMany({
      where,
      select: { companyId: true },
      distinct: ['companyId'],
      orderBy: { companyId: 'asc' },
      take: MAX_COMPANIES_PER_REDACTION + 1,
    });
    if (rows.length > MAX_COMPANIES_PER_REDACTION) {
      throw new Error('Shopify privacy redaction exceeded its company transaction budget.');
    }
    return rows.map(row => row.companyId);
  }

  private async retryConcurrentCreate(input: CreateShopifyPrivacyRequest) {
    try {
      return ok(await this.db.$transaction(tx => this.createInTransaction(tx, input)));
    } catch (cause) {
      return err(wrapInfra('prisma', 'shopifyPrivacy.create.concurrent', cause));
    }
  }
}

type AuditTransaction = Pick<Prisma.TransactionClient, 'auditLog'>;

async function writeAudit(
  tx: AuditTransaction,
  companyId: string,
  lifecycleId: string,
  state: ShopifyPrivacyState | 'accessed',
  actorId = AUDIT_ACTOR,
  evidence: Readonly<Record<string, string>> = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId,
      companyId,
      action: `shopify.privacy.${state}`,
      outcome: 'success',
      metadata: { lifecycleId, state, ...evidence },
    },
  });
}

function toSummary(row: PrismaPrivacyRequest): ShopifyPrivacyRequestSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    shopDomain: row.shopDomain,
    requestId: row.requestId,
    customerIdHash: row.customerIdHash,
    orderIdHashes: row.orderIdHashes,
    state: row.state,
    failureCode: row.failureCode,
    deadlineAt: row.deadlineAt,
    expiresAt: row.expiresAt,
    readyAt: row.readyAt,
    deliveredAt: row.deliveredAt,
    redactedAt: row.redactedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertSameSubject(
  row: PrismaPrivacyRequest,
  customerIdHash: string | null,
  orderIdHashes: readonly string[],
): void {
  if (
    row.customerIdHash !== customerIdHash
    || !sameStrings(row.orderIdHashes, orderIdHashes)
  ) {
    throw new Error('A Shopify privacy request ID was reused with different protected-data identifiers.');
  }
}

function validateStates(states: readonly ShopifyPrivacyState[]): readonly ShopifyPrivacyState[] {
  const allowed = new Set<ShopifyPrivacyState>(['received', 'ready', 'delivered', 'expired', 'redacted', 'failed']);
  if (states.length === 0 || states.some(state => !allowed.has(state))) {
    throw new Error('states must contain one or more supported Shopify privacy lifecycle states.');
  }
  return [...new Set(states)];
}

function requiredCompanyId(value: string): string {
  return preparePrivacyLookup({ companyId: value, shopDomain: 'validation.myshopify.com' }).companyId;
}

function requiredShopDomain(value: string): string {
  const normalized = normalizeShopDomain(value);
  if (!normalized) throw new Error('shopDomain must be a canonical myshopify.com domain.');
  return normalized;
}

function requiredOpaqueId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${field} must be between 1 and 256 characters.`);
  return normalized;
}

function hashAuditValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertValidTimestamp(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${field} must be a valid date.`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'P2002');
}
