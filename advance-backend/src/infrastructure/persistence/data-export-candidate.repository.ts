import type { Prisma, PrismaClient } from '../../generated/prisma';
import type {
  CreateDataExportCandidateInput,
  DataExportCandidateRecord,
  DataExportCandidateRepositoryPort,
  DataExportCandidateStatus,
  DataExportPlanRecord,
  DataExportPlanStatus,
  UpsertDataExportPlanInput,
} from '../../application/data-export/export-candidate';
import {
  parseExportCandidatePayload,
  parseExportPlanRequest,
} from '../../application/data-export/export-candidate';
import { wrapInfra } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';

type DataExportCandidateDb = Pick<PrismaClient, 'dataExportCandidate' | 'dataExportPlan'>;

const candidateSelect = {
  id: true,
  companyId: true,
  userId: true,
  departmentId: true,
  chatId: true,
  conversationKey: true,
  sourceKind: true,
  sourceConnectionId: true,
  payloadJson: true,
  payloadHash: true,
  schemaJson: true,
  previewRowCount: true,
  estimatedRows: true,
  coverageJson: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const planSelect = {
  id: true,
  companyId: true,
  userId: true,
  departmentId: true,
  chatId: true,
  conversationKey: true,
  candidateIds: true,
  planJson: true,
  planHash: true,
  destinationFormat: true,
  destinationConnectionId: true,
  status: true,
  sampleRows: true,
  sampleJobId: true,
  sampleReadyAt: true,
  fullJobId: true,
  sampleConfirmedAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type CandidateRow = {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId: string | null;
  readonly chatId: string;
  readonly conversationKey: string | null;
  readonly sourceKind: string;
  readonly sourceConnectionId: string;
  readonly payloadJson: Prisma.JsonValue;
  readonly payloadHash: string;
  readonly schemaJson: Prisma.JsonValue | null;
  readonly previewRowCount: number;
  readonly estimatedRows: number | null;
  readonly coverageJson: Prisma.JsonValue | null;
  readonly status: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type PlanRow = {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId: string | null;
  readonly chatId: string;
  readonly conversationKey: string | null;
  readonly candidateIds: readonly string[];
  readonly planJson: Prisma.JsonValue;
  readonly planHash: string;
  readonly destinationFormat: string;
  readonly destinationConnectionId: string | null;
  readonly status: string;
  readonly sampleRows: number | null;
  readonly sampleJobId: string | null;
  readonly sampleReadyAt: Date | null;
  readonly fullJobId: string | null;
  readonly sampleConfirmedAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export class DataExportCandidateRepository implements DataExportCandidateRepositoryPort {
  constructor(private readonly db: DataExportCandidateDb) {}

  async createCandidate(
    input: CreateDataExportCandidateInput,
  ): Promise<Result<DataExportCandidateRecord, Error>> {
    try {
      const row = await this.db.dataExportCandidate.create({
        data: {
          companyId: input.payload.companyId,
          userId: input.payload.userId,
          ...(input.payload.departmentId ? { departmentId: input.payload.departmentId } : {}),
          chatId: input.payload.chatId,
          ...(input.payload.conversationKey ? { conversationKey: input.payload.conversationKey } : {}),
          sourceKind: input.payload.source.kind,
          sourceConnectionId: input.payload.source.connectionId,
          payloadJson: input.payload as unknown as Prisma.InputJsonValue,
          payloadHash: input.payloadHash,
          ...(input.metadata.schema ? { schemaJson: input.metadata.schema as unknown as Prisma.InputJsonValue } : {}),
          previewRowCount: input.metadata.previewRowCount ?? 0,
          ...(input.metadata.estimatedRows !== undefined ? { estimatedRows: input.metadata.estimatedRows } : {}),
          ...(input.metadata.coverage !== undefined ? { coverageJson: input.metadata.coverage as Prisma.InputJsonValue } : {}),
          expiresAt: input.expiresAt,
        },
        select: candidateSelect,
      });
      return ok(toCandidateRecord(row));
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportCandidate.create', cause));
    }
  }

  async listActiveForActor(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly scope?: 'chat' | 'run';
    readonly runRequestId?: string;
    readonly traceId?: string;
    readonly limit?: number;
    readonly now?: Date;
  }): Promise<Result<readonly DataExportCandidateRecord[], Error>> {
    const now = input.now ?? new Date();
    const limit = input.limit ?? 50;
    try {
      const rows = await this.db.dataExportCandidate.findMany({
        where: {
          companyId: input.companyId,
          userId: input.userId,
          chatId: input.chatId,
          status: 'active',
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit * 2, 100),
        select: candidateSelect,
      });
      const records = rows.map(row => toCandidateRecord(row));
      const scoped = input.scope === 'run'
        ? records.filter(candidate => matchesRunScope(candidate, input))
        : records;
      return ok(scoped.slice(0, limit));
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportCandidate.listActiveForActor', cause));
    }
  }

  async loadCandidatesForPlan(input: {
    readonly candidateIds: readonly string[];
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly now?: Date;
  }): Promise<Result<readonly DataExportCandidateRecord[], Error>> {
    const now = input.now ?? new Date();
    try {
      const rows = await this.db.dataExportCandidate.findMany({
        where: {
          id: { in: [...new Set(input.candidateIds)] },
          companyId: input.companyId,
          userId: input.userId,
          chatId: input.chatId,
          status: 'active',
          expiresAt: { gt: now },
        },
        select: candidateSelect,
      });
      const byId = new Map(rows.map(row => [row.id, toCandidateRecord(row)]));
      return ok(input.candidateIds.flatMap(id => {
        const candidate = byId.get(id);
        return candidate ? [candidate] : [];
      }));
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportCandidate.loadForPlan', cause));
    }
  }

  async upsertPlan(input: UpsertDataExportPlanInput): Promise<Result<DataExportPlanRecord, Error>> {
    try {
      const data = {
        companyId: input.companyId,
        userId: input.userId,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
        chatId: input.chatId,
        ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
        candidateIds: [...input.candidateIds],
        planJson: input.plan as unknown as Prisma.InputJsonValue,
        planHash: input.planHash,
        destinationFormat: input.destinationFormat,
        ...(input.destinationConnectionId ? { destinationConnectionId: input.destinationConnectionId } : {}),
        ...(input.sampleRows !== undefined ? { sampleRows: input.sampleRows } : {}),
        expiresAt: input.expiresAt,
      };
      const row = await this.db.dataExportPlan.upsert({
        where: {
          companyId_userId_chatId_planHash: {
            companyId: input.companyId,
            userId: input.userId,
            chatId: input.chatId,
            planHash: input.planHash,
          },
        },
        create: data,
        update: {
          updatedAt: input.now,
          expiresAt: input.expiresAt,
          ...(input.destinationConnectionId ? { destinationConnectionId: input.destinationConnectionId } : {}),
          ...(input.sampleRows !== undefined ? { sampleRows: input.sampleRows } : {}),
        },
        select: planSelect,
      });
      return ok(toPlanRecord(row));
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportPlan.upsert', cause));
    }
  }

  async loadPlanForActor(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>> {
    const now = input.now ?? new Date();
    try {
      const row = await this.db.dataExportPlan.findFirst({
        where: {
          id: input.planId,
          companyId: input.companyId,
          userId: input.userId,
          chatId: input.chatId,
          status: { in: ['planned', 'sample_queued', 'sample_ready', 'full_queued'] },
          expiresAt: { gt: now },
        },
        select: planSelect,
      });
      return ok(row ? toPlanRecord(row) : null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportPlan.loadForActor', cause));
    }
  }

  async markSampleQueued(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly sampleJobId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>> {
    const now = input.now ?? new Date();
    try {
      const updated = await this.db.dataExportPlan.updateMany({
        where: {
          id: input.planId,
          companyId: input.companyId,
          userId: input.userId,
          status: 'planned',
          expiresAt: { gt: now },
        },
        data: {
          status: 'sample_queued',
          sampleJobId: input.sampleJobId,
          updatedAt: now,
        },
      });
      const row = await this.db.dataExportPlan.findFirst({
        where: { id: input.planId, companyId: input.companyId, userId: input.userId },
        select: planSelect,
      });
      return ok(updated.count === 1 && row ? toPlanRecord(row) : null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportPlan.markSampleQueued', cause));
    }
  }

  async markSampleReady(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly sampleJobId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>> {
    const now = input.now ?? new Date();
    try {
      const updated = await this.db.dataExportPlan.updateMany({
        where: {
          id: input.planId,
          companyId: input.companyId,
          userId: input.userId,
          status: 'sample_queued',
          sampleJobId: input.sampleJobId,
          expiresAt: { gt: now },
        },
        data: {
          status: 'sample_ready',
          sampleReadyAt: now,
          updatedAt: now,
        },
      });
      const row = await this.db.dataExportPlan.findFirst({
        where: { id: input.planId, companyId: input.companyId, userId: input.userId },
        select: planSelect,
      });
      if (updated.count === 1 && row) return ok(toPlanRecord(row));
      if (
        row?.status === 'sample_ready'
        && row.sampleJobId === input.sampleJobId
        && row.expiresAt.getTime() > now.getTime()
      ) {
        return ok(toPlanRecord(row));
      }
      return ok(null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportPlan.markSampleReady', cause));
    }
  }

  async markFullQueued(input: {
    readonly planId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly fullJobId: string;
    readonly now?: Date;
  }): Promise<Result<DataExportPlanRecord | null, Error>> {
    const now = input.now ?? new Date();
    try {
      const updated = await this.db.dataExportPlan.updateMany({
        where: {
          id: input.planId,
          companyId: input.companyId,
          userId: input.userId,
          status: { in: ['planned', 'sample_ready'] },
          expiresAt: { gt: now },
        },
        data: {
          status: 'full_queued',
          fullJobId: input.fullJobId,
          sampleConfirmedAt: now,
          updatedAt: now,
        },
      });
      const row = await this.db.dataExportPlan.findFirst({
        where: { id: input.planId, companyId: input.companyId, userId: input.userId },
        select: planSelect,
      });
      return ok(updated.count === 1 && row ? toPlanRecord(row) : null);
    } catch (cause) {
      return err(wrapInfra('prisma', 'dataExportPlan.markFullQueued', cause));
    }
  }
}

function toCandidateRecord(row: CandidateRow): DataExportCandidateRecord {
  const payload = parseExportCandidatePayload(row.payloadJson);
  if (row.sourceKind !== payload.source.kind) {
    throw new Error('Data export candidate source kind does not match its payload');
  }
  if (row.sourceConnectionId !== payload.source.connectionId) {
    throw new Error('Data export candidate connection does not match its payload');
  }
  const schema = Array.isArray(row.schemaJson)
    ? row.schemaJson
      .filter((value): value is { name: string; type?: string } => (
        typeof value === 'object'
        && value !== null
        && typeof (value as { name?: unknown }).name === 'string'
      ))
      .map(value => ({
        name: value.name,
        ...(typeof value.type === 'string' ? { type: value.type } : {}),
      }))
    : undefined;
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    ...(row.departmentId ? { departmentId: row.departmentId } : {}),
    chatId: row.chatId,
    ...(row.conversationKey ? { conversationKey: row.conversationKey } : {}),
    sourceKind: payload.source.kind,
    sourceConnectionId: row.sourceConnectionId,
    payload,
    payloadHash: row.payloadHash,
    ...(schema ? { schema } : {}),
    previewRowCount: row.previewRowCount,
    ...(row.estimatedRows === null ? {} : { estimatedRows: row.estimatedRows }),
    ...(row.coverageJson === null ? {} : { coverage: row.coverageJson }),
    status: parseCandidateStatus(row.status),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPlanRecord(row: PlanRow): DataExportPlanRecord {
  const plan = parseExportPlanRequest(row.planJson);
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    ...(row.departmentId ? { departmentId: row.departmentId } : {}),
    chatId: row.chatId,
    ...(row.conversationKey ? { conversationKey: row.conversationKey } : {}),
    candidateIds: row.candidateIds,
    plan,
    planHash: row.planHash,
    destinationFormat: parseDestinationFormat(row.destinationFormat),
    ...(row.destinationConnectionId ? { destinationConnectionId: row.destinationConnectionId } : {}),
    status: parsePlanStatus(row.status),
    ...(row.sampleRows === null ? {} : { sampleRows: row.sampleRows }),
    ...(row.sampleJobId ? { sampleJobId: row.sampleJobId } : {}),
    ...(row.sampleReadyAt ? { sampleReadyAt: row.sampleReadyAt } : {}),
    ...(row.fullJobId ? { fullJobId: row.fullJobId } : {}),
    ...(row.sampleConfirmedAt ? { sampleConfirmedAt: row.sampleConfirmedAt } : {}),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseCandidateStatus(value: string): DataExportCandidateStatus {
  switch (value) {
    case 'active':
    case 'expired':
    case 'cancelled':
      return value;
    default:
      throw new Error(`Unknown data export candidate status: ${value}`);
  }
}

function parsePlanStatus(value: string): DataExportPlanStatus {
  switch (value) {
    case 'planned':
    case 'sample_queued':
    case 'sample_ready':
    case 'full_queued':
    case 'expired':
    case 'cancelled':
      return value;
    default:
      throw new Error(`Unknown data export plan status: ${value}`);
  }
}

function parseDestinationFormat(value: string): DataExportPlanRecord['destinationFormat'] {
  switch (value) {
    case 'google_sheet':
    case 'csv':
    case 'xlsx':
      return value;
    default:
      throw new Error(`Unknown data export plan destination format: ${value}`);
  }
}

function matchesRunScope(
  candidate: DataExportCandidateRecord,
  input: { readonly runRequestId?: string; readonly traceId?: string },
): boolean {
  if (input.runRequestId && candidate.payload.requestId === input.runRequestId) {
    return true;
  }
  if (input.traceId && candidate.payload.traceId === input.traceId) {
    return true;
  }
  return !input.runRequestId && !input.traceId;
}
