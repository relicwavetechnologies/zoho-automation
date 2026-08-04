import { z } from 'zod';
import type { Result } from '../../shared/result';
import {
  datasetSourceSchema,
  type DataExportJobPayload,
  type DataExportSource,
} from './data-export.types';
import { DATA_EXPORT_MAX_PARTS } from './data-export-limits';

export const DATA_EXPORT_OFFER_TTL_MS = 24 * 60 * 60 * 1_000;

export const dataExportTransformSchema = z.object({
  script: z.string().min(1).max(20_000),
  args: z.record(z.unknown()).optional(),
}).strict();

export const dataExportDestinationSchema = z.object({
  format: z.enum(['auto', 'google_sheet', 'csv', 'xlsx']),
  title: z.string().min(1).max(120),
  columns: z.array(z.string().min(1)).max(500).optional(),
}).strict();

export type DataExportOfferPayload = Omit<
  DataExportJobPayload,
  'progressMessageId' | 'completedExport'
>;

export const dataExportOfferPayloadSchema = z.object({
  companyId: z.string().min(1),
  userId: z.string().min(1),
  departmentId: z.string().min(1).optional(),
  source: datasetSourceSchema,
  additionalParts: z.array(datasetSourceSchema).max(DATA_EXPORT_MAX_PARTS - 1).optional(),
  observedRowCount: z.number().int().nonnegative().optional(),
  transform: dataExportTransformSchema.optional(),
  destination: dataExportDestinationSchema,
  chatId: z.string().min(1),
  conversationKey: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
  replyInThread: z.boolean().optional(),
  requestId: z.string().min(1),
  traceId: z.string().min(1).optional(),
}).strict();

/**
 * Rebuilds a source with only its declared fields, so a persisted payload can
 * never smuggle an extra key back through a later confirmation.
 */
function normalizeDatasetSource(source: DataExportSource): DataExportSource {
  return source.kind === 'airtable_records'
    ? { ...source }
    : source.kind === 'zoho_books' ? {
        kind: source.kind,
        connectionId: source.connectionId,
        module: source.module,
        ...(source.organizationId ? { organizationId: source.organizationId } : {}),
        ...(source.filters ? { filters: source.filters } : {}),
        ...(source.query ? { query: source.query } : {}),
      }
    : source.kind === 'zoho_crm' ? {
        kind: source.kind,
        connectionId: source.connectionId,
        module: source.module,
        ...(source.sortBy ? { sortBy: source.sortBy } : {}),
        ...(source.sortOrder ? { sortOrder: source.sortOrder } : {}),
      }
    : source.kind === 'oms_snapshot' ? {
        kind: source.kind,
        connectionId: source.connectionId,
        args: source.args,
      }
    : source.kind === 'menhood_query' ? {
        kind: source.kind,
        connectionId: source.connectionId,
        query: source.query,
        queryFingerprint: source.queryFingerprint,
      }
    : {
        kind: source.kind,
        connectionId: source.connectionId,
        args: source.args,
      };
}

export function parseDataExportOfferPayload(value: unknown): DataExportOfferPayload {
  const parsed = dataExportOfferPayloadSchema.parse(value);
  const source = normalizeDatasetSource(parsed.source);
  const additionalParts = parsed.additionalParts?.map(normalizeDatasetSource);
  const transform: DataExportOfferPayload['transform'] = parsed.transform
    ? {
        script: parsed.transform.script,
        ...(parsed.transform.args ? { args: parsed.transform.args } : {}),
      }
    : undefined;
  const destination: DataExportOfferPayload['destination'] = {
    format: parsed.destination.format,
    title: parsed.destination.title,
    ...(parsed.destination.columns ? { columns: parsed.destination.columns } : {}),
  };
  return {
    companyId: parsed.companyId,
    userId: parsed.userId,
    ...(parsed.departmentId ? { departmentId: parsed.departmentId } : {}),
    source,
    ...(additionalParts && additionalParts.length > 0 ? { additionalParts } : {}),
    ...(parsed.observedRowCount !== undefined
      ? { observedRowCount: parsed.observedRowCount }
      : {}),
    ...(transform ? { transform } : {}),
    destination,
    chatId: parsed.chatId,
    ...(parsed.conversationKey ? { conversationKey: parsed.conversationKey } : {}),
    ...(parsed.replyToMessageId ? { replyToMessageId: parsed.replyToMessageId } : {}),
    ...(parsed.replyInThread !== undefined ? { replyInThread: parsed.replyInThread } : {}),
    requestId: parsed.requestId,
    ...(parsed.traceId ? { traceId: parsed.traceId } : {}),
  };
}

export type DataExportOfferStatus =
  | 'pending'
  | 'confirming'
  | 'confirmed'
  | 'expired'
  | 'cancelled';

export interface DataExportOfferRecord {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly sourceKind: DataExportOfferPayload['source']['kind'];
  readonly sourceConnectionId: string;
  readonly payload: DataExportOfferPayload;
  readonly specHash: string;
  readonly idempotencyKey: string;
  readonly status: DataExportOfferStatus;
  /** Most recently confirmed artifact. Not a ledger — see `confirmedJobIds`. */
  readonly queueJobId?: string;
  /** Every artifact already produced, one job id per destination format. */
  readonly confirmedJobIds: readonly string[];
  readonly expiresAt: Date;
  readonly confirmedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateDataExportOfferInput {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly sourceKind: DataExportOfferPayload['source']['kind'];
  readonly sourceConnectionId: string;
  readonly payload: DataExportOfferPayload;
  readonly specHash: string;
  readonly idempotencyKey: string;
  readonly now: Date;
  readonly expiresAt: Date;
}

export type CreateDataExportOfferResult =
  | { readonly outcome: 'created'; readonly offer: DataExportOfferRecord }
  | { readonly outcome: 'existing'; readonly offer: DataExportOfferRecord };

export type ClaimDataExportOfferResult =
  | { readonly outcome: 'claimed'; readonly offer: DataExportOfferRecord }
  | { readonly outcome: 'in_progress'; readonly offer: DataExportOfferRecord }
  | { readonly outcome: 'already_confirmed'; readonly offer: DataExportOfferRecord; readonly queueJobId: string }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'not_found' };

export type LoadDataExportOfferResult =
  | { readonly outcome: 'found'; readonly offer: DataExportOfferRecord }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'not_found' };

export interface ReplacePendingDataExportOfferInput {
  readonly offerId: string;
  readonly companyId: string;
  /** Compare-and-set token: the hash this update believes it is replacing. */
  readonly expectedSpecHash: string;
  readonly payload: DataExportOfferPayload;
  readonly specHash: string;
  readonly now?: Date;
}

export type ReplacePendingDataExportOfferResult =
  | { readonly outcome: 'replaced'; readonly offer: DataExportOfferRecord }
  /** Another append won the race, or the offer left `pending`. Re-read and retry. */
  | { readonly outcome: 'stale' };

export interface DataExportOfferRepositoryPort {
  create(
    input: CreateDataExportOfferInput,
  ): Promise<Result<CreateDataExportOfferResult, Error>>;
  /**
   * Swap a still-pending offer's payload, but only if `expectedSpecHash` still
   * describes it. Two tool calls appending at once cannot lose a part this way:
   * the loser sees `stale` and retries against the winner's payload.
   */
  replacePendingPayload(
    input: ReplacePendingDataExportOfferInput,
  ): Promise<Result<ReplacePendingDataExportOfferResult, Error>>;
  /** Withdraw a pending offer so no card can confirm a partial dataset. */
  cancelPending(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly now?: Date;
  }): Promise<Result<boolean, Error>>;
  loadForConfirmation(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly now?: Date;
  }): Promise<Result<LoadDataExportOfferResult, Error>>;
  /**
   * Returns active offers for one authenticated Lark conversation. The method
   * is optional so confirmation tests and non-Lark compositions do not need a
   * second lookup path; the production repository implements it.
   */
  findActiveForActor?(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly now?: Date;
  }): Promise<Result<readonly DataExportOfferRecord[], Error>>;
  claimConfirmation(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    /**
     * Job identity of the artifact this confirmation wants. A confirmed offer
     * re-opens for a different one, because Sheet, CSV and Excel are three
     * files, not three names for the first click's file.
     */
    readonly requestedJobId?: string;
    readonly now?: Date;
  }): Promise<Result<ClaimDataExportOfferResult, Error>>;
  markConfirmed(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly queueJobId: string;
    readonly confirmedAt?: Date;
  }): Promise<Result<boolean, Error>>;
}
