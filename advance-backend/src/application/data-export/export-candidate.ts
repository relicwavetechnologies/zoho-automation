import { z } from 'zod';
import type { Result } from '../../shared/result';
import {
  DATA_EXPORT_OFFER_TTL_MS,
  dataExportDestinationSchema,
  parseDataExportOfferPayload,
  type DataExportOfferPayload,
} from './export-offer';
export const DATA_EXPORT_CANDIDATE_TTL_MS = DATA_EXPORT_OFFER_TTL_MS;

export const exportCandidateColumnSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().min(1).max(80).optional(),
}).strict();

export const exportCandidateMetadataSchema = z.object({
  schema: z.array(exportCandidateColumnSchema).max(500).optional(),
  previewRowCount: z.number().int().nonnegative().optional(),
  estimatedRows: z.number().int().nonnegative().optional(),
  coverage: z.unknown().optional(),
}).strict();

export type ExportCandidateMetadata = z.infer<typeof exportCandidateMetadataSchema>;

const exportPlanDatasetSchema = z.object({
  candidateId: z.string().uuid(),
  title: z.string().min(1).max(120).optional(),
  columns: z.array(z.string().min(1)).max(500).optional(),
  tabName: z.string().min(1).max(80).optional(),
}).strict();

export const exportPlanRequestSchema = z.object({
  datasets: z.array(exportPlanDatasetSchema).min(1).max(10),
  destination: dataExportDestinationSchema
    .omit({ format: true })
    .extend({
      format: z.enum(['google_sheet', 'csv', 'xlsx']),
      connectionId: z.string().uuid().optional(),
    })
    .strict(),
  userIntent: z.literal('explicit_export'),
}).strict();

export type ExportPlanRequest = z.infer<typeof exportPlanRequestSchema>;

export type DataExportCandidateStatus = 'active' | 'expired' | 'cancelled';

export interface DataExportCandidateRecord {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly chatId: string;
  readonly conversationKey?: string;
  readonly sourceKind: DataExportOfferPayload['source']['kind'];
  readonly sourceConnectionId: string;
  readonly payload: DataExportOfferPayload;
  readonly payloadHash: string;
  readonly schema?: readonly { readonly name: string; readonly type?: string }[];
  readonly previewRowCount: number;
  readonly estimatedRows?: number;
  readonly coverage?: unknown;
  readonly status: DataExportCandidateStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type DataExportPlanStatus =
  | 'planned'
  // Legacy states remain readable while pre-cutover sample jobs drain. New
  // plans can only move from planned to full_queued.
  | 'sample_queued'
  | 'sample_ready'
  | 'full_queued'
  | 'expired'
  | 'cancelled';

export interface DataExportPlanRecord {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly chatId: string;
  readonly conversationKey?: string;
  readonly candidateIds: readonly string[];
  readonly plan: ExportPlanRequest;
  readonly planHash: string;
  readonly destinationFormat: ExportPlanRequest['destination']['format'];
  readonly destinationConnectionId?: string;
  readonly status: DataExportPlanStatus;
  readonly sampleRows?: number;
  readonly sampleJobId?: string;
  readonly sampleReadyAt?: Date;
  readonly fullJobId?: string;
  readonly sampleConfirmedAt?: Date;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateDataExportCandidateInput {
  readonly payload: DataExportOfferPayload;
  readonly payloadHash: string;
  readonly metadata: ExportCandidateMetadata;
  readonly now: Date;
  readonly expiresAt: Date;
}

export interface UpsertDataExportPlanInput {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly chatId: string;
  readonly conversationKey?: string;
  readonly candidateIds: readonly string[];
  readonly plan: ExportPlanRequest;
  readonly planHash: string;
  readonly destinationFormat: ExportPlanRequest['destination']['format'];
  readonly destinationConnectionId?: string;
  readonly sampleRows?: number;
  readonly now: Date;
  readonly expiresAt: Date;
}

export interface DataExportCandidateRepositoryPort {
  createCandidate(input: CreateDataExportCandidateInput): Promise<Result<DataExportCandidateRecord, Error>>;
  listActiveForActor(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly scope?: 'chat' | 'run';
    readonly runRequestId?: string;
    readonly traceId?: string;
    readonly limit?: number;
    readonly now?: Date;
  }): Promise<Result<readonly DataExportCandidateRecord[], Error>>;
  loadCandidatesForPlan(input: {
    readonly candidateIds: readonly string[];
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly now?: Date;
  }): Promise<Result<readonly DataExportCandidateRecord[], Error>>;
  upsertPlan(input: UpsertDataExportPlanInput): Promise<Result<DataExportPlanRecord, Error>>;
  loadPlanForActor(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>>;
  markSampleQueued(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly sampleJobId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>>;
  markSampleReady(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly sampleJobId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>>;
  markFullQueued(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly fullJobId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>>;
}

export function parseExportCandidatePayload(value: unknown): DataExportOfferPayload {
  return parseDataExportOfferPayload(value);
}

export function parseExportPlanRequest(value: unknown): ExportPlanRequest {
  return exportPlanRequestSchema.parse(value);
}
