import { z } from 'zod';
import type { Result } from '../../shared/result';
import {
  datasetSourceSchema,
  type DataExportJobPayload,
} from './data-export.types';

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
  transform: dataExportTransformSchema.optional(),
  destination: dataExportDestinationSchema,
  chatId: z.string().min(1),
  replyToMessageId: z.string().min(1).optional(),
  replyInThread: z.boolean().optional(),
  requestId: z.string().min(1),
  traceId: z.string().min(1).optional(),
}).strict();

export function parseDataExportOfferPayload(value: unknown): DataExportOfferPayload {
  const parsed = dataExportOfferPayloadSchema.parse(value);
  const source: DataExportOfferPayload['source'] = parsed.source.kind === 'airtable_records'
    ? { ...parsed.source }
    : parsed.source.kind === 'zoho_books' ? {
        kind: parsed.source.kind,
        connectionId: parsed.source.connectionId,
        module: parsed.source.module,
        ...(parsed.source.organizationId ? { organizationId: parsed.source.organizationId } : {}),
        ...(parsed.source.filters ? { filters: parsed.source.filters } : {}),
        ...(parsed.source.query ? { query: parsed.source.query } : {}),
      }
    : parsed.source.kind === 'oms_snapshot' ? {
        kind: parsed.source.kind,
        connectionId: parsed.source.connectionId,
        args: parsed.source.args,
      }
    : {
        kind: parsed.source.kind,
        connectionId: parsed.source.connectionId,
        args: parsed.source.args,
      };
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
    ...(transform ? { transform } : {}),
    destination,
    chatId: parsed.chatId,
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
  readonly queueJobId?: string;
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

export interface DataExportOfferRepositoryPort {
  create(
    input: CreateDataExportOfferInput,
  ): Promise<Result<CreateDataExportOfferResult, Error>>;
  loadForConfirmation(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly now?: Date;
  }): Promise<Result<LoadDataExportOfferResult, Error>>;
  claimConfirmation(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
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
