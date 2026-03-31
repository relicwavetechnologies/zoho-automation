import type {
  ExecutionCapabilityGapInsightDTO,
  ExecutionDemandInsightDTO,
  ExecutionActorType,
  ExecutionEventItemDTO,
  ExecutionInsightsDTO,
  ExecutionPhase,
  ExecutionRunDetailDTO,
  ExecutionRunFiltersDTO,
  ExecutionRunListItemDTO,
} from '../../contracts';
import { HttpException } from '../../../core/http-exception';
import { BaseService } from '../../../core/service';
import { Prisma } from '../../../generated/prisma';

import {
  executionRepository,
  type ExecutionEventRow,
  type ExecutionRunRow,
  type ExecutionRepository,
} from './repository';
import { stepResultRepository, type StepResultRow } from './step-result.repository';
import type {
  AppendExecutionEventInput,
  CancelExecutionRunInput,
  CompleteExecutionRunInput,
  ExecutionEventListResponse,
  ExecutionInsightsResponse,
  ExecutionRunDetailResponse,
  ExecutionRunListResponse,
  ExecutionRunQuery,
  ExecutionRunScope,
  FailExecutionRunInput,
  StartExecutionRunInput,
} from './types';
import {
  EXECUTION_CAPABILITY_GAP_EVENT,
  EXECUTION_TOOL_DEMAND_EVENT,
  type ExecutionCapabilityGapPayload,
  type ExecutionToolDemandPayload,
} from './insights';

const REDACTED_KEYS = new Set([
  'rawEvent',
  'rawInput',
  'reasoning',
  'thinking',
  'thinkingText',
  'cot',
  'chainOfThought',
]);

const REDACTED_VIEW_KEYS = new Set([
  'prompt',
  'systemPrompt',
  'history',
  'historyContext',
  'memoryContext',
  'requestContext',
  'fullPrompt',
  'toolInput',
  'inputMessages',
  'modelInput',
  'toolCall',
]);

const resolvePayloadVisibility = (scope: ExecutionRunScope): 'full' | 'redacted' => (
  scope.role === 'admin' && scope.adminRole === 'SUPER_ADMIN' ? 'full' : 'redacted'
);

const sanitizePayloadValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 20_000 ? `${value.slice(0, 20_000)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizePayloadValue);
  if (typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key)) continue;
      next[key] = sanitizePayloadValue(entry);
    }
    return next;
  }
  return String(value);
};

const normalizePayload = (payload?: Record<string, unknown> | null): Record<string, unknown> | null => {
  if (!payload) return null;
  const sanitized = sanitizePayloadValue(payload);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : null;
};

const redactPayloadForView = (
  payload: Record<string, unknown> | null,
  visibility: 'full' | 'redacted',
): Record<string, unknown> | null => {
  if (!payload) return null;
  if (visibility === 'full') return payload;

  const redactValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_VIEW_KEYS.has(key)) {
        continue;
      }
      next[key] = redactValue(entry);
    }
    return next;
  };

  const redacted = redactValue(payload);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : null;
};

const buildDateBoundary = (value: string, boundary: 'start' | 'end'): Date => {
  const date = new Date(value);
  if (boundary === 'start') {
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
};

const mapRun = (row: ExecutionRunRow): ExecutionRunDetailDTO => ({
  id: row.id,
  companyId: row.companyId,
  companyName: row.company?.name ?? null,
  userId: row.userId ?? null,
  userName: row.user?.name ?? null,
  userEmail: row.user?.email ?? null,
  channel: row.channel as ExecutionRunDetailDTO['channel'],
  entrypoint: row.entrypoint,
  requestId: row.requestId ?? null,
  taskId: row.taskId ?? null,
  threadId: row.threadId ?? null,
  chatId: row.chatId ?? null,
  messageId: row.messageId ?? null,
  mode: (row.mode as ExecutionRunDetailDTO['mode']) ?? null,
  agentTarget: row.agentTarget ?? null,
  status: row.status as ExecutionRunDetailDTO['status'],
  latestSummary: row.latestSummary ?? null,
  errorCode: row.errorCode ?? null,
  errorMessage: row.errorMessage ?? null,
  eventCount: row._count.events,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
});

const mapEvent = (
  row: ExecutionEventRow,
  visibility: 'full' | 'redacted',
): ExecutionEventItemDTO => ({
  id: row.id,
  executionId: row.executionId,
  sequence: row.sequence,
  phase: row.phase as ExecutionPhase,
  eventType: row.eventType,
  actorType: row.actorType as ExecutionActorType,
  actorKey: row.actorKey ?? null,
  title: row.title,
  summary: row.summary ?? null,
  status: row.status ?? null,
  payload: redactPayloadForView(
    normalizePayload((row.payload ?? null) as Record<string, unknown> | null),
    visibility,
  ),
  createdAt: row.createdAt.toISOString(),
});

const buildScopeWhere = (scope: ExecutionRunScope): Prisma.ExecutionRunWhereInput => {
  if (scope.role === 'member') {
    return {
      companyId: scope.companyId,
      userId: scope.userId,
    };
  }

  if (scope.adminRole === 'COMPANY_ADMIN') {
    return {
      companyId: scope.companyId,
    };
  }

  return {};
};

const buildFilterWhere = (filters: ExecutionRunQuery): Prisma.ExecutionRunWhereInput => {
  const where: Prisma.ExecutionRunWhereInput = {};

  if (filters.userId) where.userId = filters.userId;
  if (filters.companyId) where.companyId = filters.companyId;
  if (filters.channel) where.channel = filters.channel;
  if (filters.mode) where.mode = filters.mode;
  if (filters.status) where.status = filters.status;
  if (filters.dateFrom || filters.dateTo) {
    where.startedAt = {
      ...(filters.dateFrom ? { gte: buildDateBoundary(filters.dateFrom, 'start') } : {}),
      ...(filters.dateTo ? { lte: buildDateBoundary(filters.dateTo, 'end') } : {}),
    };
  }

  if (filters.query?.trim()) {
    const query = filters.query.trim();
    where.OR = [
      { id: { contains: query, mode: 'insensitive' } },
      { requestId: { contains: query, mode: 'insensitive' } },
      { taskId: { contains: query, mode: 'insensitive' } },
      { threadId: { contains: query, mode: 'insensitive' } },
      { user: { is: { email: { contains: query, mode: 'insensitive' } } } },
      { user: { is: { name: { contains: query, mode: 'insensitive' } } } },
    ];
  }

  if (filters.phase || filters.actorType) {
    where.events = {
      some: {
        ...(filters.phase ? { phase: filters.phase } : {}),
        ...(filters.actorType ? { actorType: filters.actorType } : {}),
      },
    };
  }

  return where;
};

const asExecutionChannel = (value: unknown): 'desktop' | 'lark' | null =>
  value === 'desktop' || value === 'lark' ? value : null;

const coerceDemandPayload = (value: unknown): ExecutionToolDemandPayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const family = typeof payload.intendedToolFamily === 'string' ? payload.intendedToolFamily.trim() : '';
  const userQuery = typeof payload.userQuery === 'string' ? payload.userQuery.trim() : '';
  if (!family || !userQuery) return null;
  return {
    channel: asExecutionChannel(payload.channel) ?? 'desktop',
    userQuery,
    enrichedQuery: typeof payload.enrichedQuery === 'string' ? payload.enrichedQuery : null,
    normalizedIntent: typeof payload.normalizedIntent === 'string' ? payload.normalizedIntent : null,
    canonicalIntentKey: typeof payload.canonicalIntentKey === 'string' ? payload.canonicalIntentKey : 'unknown:read:general:unspecified',
    inferredDomain: typeof payload.inferredDomain === 'string' ? payload.inferredDomain as ExecutionToolDemandPayload['inferredDomain'] : 'unknown',
    inferredOperationClass: typeof payload.inferredOperationClass === 'string'
      ? payload.inferredOperationClass as ExecutionToolDemandPayload['inferredOperationClass']
      : 'read',
    intendedToolFamily: family,
    plannerChosenToolId: typeof payload.plannerChosenToolId === 'string' ? payload.plannerChosenToolId : null,
    plannerChosenOperationClass: typeof payload.plannerChosenOperationClass === 'string'
      ? payload.plannerChosenOperationClass as ExecutionToolDemandPayload['plannerChosenOperationClass']
      : null,
    plannerCandidateToolIds: Array.isArray(payload.plannerCandidateToolIds)
      ? payload.plannerCandidateToolIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    runExposedToolIds: Array.isArray(payload.runExposedToolIds)
      ? payload.runExposedToolIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    selectionReason: typeof payload.selectionReason === 'string' ? payload.selectionReason : '',
    clarificationTriggered: Boolean(payload.clarificationTriggered),
    validationFailureReason: typeof payload.validationFailureReason === 'string' ? payload.validationFailureReason : null,
  };
};

const coerceGapPayload = (value: unknown): ExecutionCapabilityGapPayload | null => {
  const base = coerceDemandPayload(value);
  if (!base || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const gapKey = typeof payload.gapKey === 'string' ? payload.gapKey.trim() : '';
  const gapLabel = typeof payload.gapLabel === 'string' ? payload.gapLabel.trim() : '';
  const gapKind = typeof payload.gapKind === 'string' ? payload.gapKind.trim() : '';
  if (!gapKey || !gapLabel || !gapKind) return null;
  return {
    ...base,
    gapKind: gapKind as ExecutionCapabilityGapPayload['gapKind'],
    gapKey,
    gapLabel,
    failedToolId: typeof payload.failedToolId === 'string' ? payload.failedToolId : null,
    errorKind: typeof payload.errorKind === 'string' ? payload.errorKind : null,
    errorMessage: typeof payload.errorMessage === 'string' ? payload.errorMessage : null,
  };
};

const takeSampleQueries = (queries: Set<string>): string[] => Array.from(queries).slice(0, 3);

export class ExecutionService extends BaseService {
  constructor(private readonly repository: ExecutionRepository = executionRepository) {
    super();
  }

  async startRun(input: StartExecutionRunInput): Promise<ExecutionRunDetailDTO> {
    if (input.requestId) {
      const existing = await this.repository.findByRequestId(input.requestId);
      if (existing) return mapRun(existing);
    }
    return mapRun(await this.repository.createRun(input));
  }

  async appendEvent(input: AppendExecutionEventInput): Promise<ExecutionEventItemDTO> {
    return mapEvent(await this.repository.appendEvent({
      ...input,
      payload: normalizePayload(input.payload),
    }), 'full');
  }

  async completeRun(input: CompleteExecutionRunInput): Promise<ExecutionRunDetailDTO> {
    return mapRun(await this.repository.completeRun(input));
  }

  async failRun(input: FailExecutionRunInput): Promise<ExecutionRunDetailDTO> {
    return mapRun(await this.repository.failRun(input));
  }

  async cancelRun(input: CancelExecutionRunInput): Promise<ExecutionRunDetailDTO> {
    return mapRun(await this.repository.cancelRun(input));
  }

  async getRun(scope: ExecutionRunScope, executionId: string): Promise<ExecutionRunDetailResponse> {
    const row = await this.repository.findById(executionId);
    if (!row) throw new HttpException(404, 'Execution run not found');

    const scopeWhere = buildScopeWhere(scope);
    if (scopeWhere.companyId && row.companyId !== scopeWhere.companyId) {
      throw new HttpException(404, 'Execution run not found');
    }
    if (scope.role === 'member' && row.userId !== scope.userId) {
      throw new HttpException(404, 'Execution run not found');
    }

    return { run: mapRun(row) };
  }

  async listRuns(scope: ExecutionRunScope, filters: ExecutionRunFiltersDTO): Promise<ExecutionRunListResponse> {
    const where: Prisma.ExecutionRunWhereInput = {
      AND: [
        buildScopeWhere(scope),
        buildFilterWhere(filters),
      ],
    };

    const [items, total, byStatus, byChannel, byMode] = await Promise.all([
      this.repository.listRuns({ where, page: filters.page, pageSize: filters.pageSize }),
      this.repository.countRuns(where),
      this.repository.groupRuns(where, ['status']),
      this.repository.groupRuns(where, ['channel']),
      this.repository.groupRuns(where, ['mode']),
    ]);

    const statusCounts = new Map(byStatus.map((entry) => [String(entry.status ?? ''), entry._count._all]));
    const channelSummary: Partial<Record<'desktop' | 'lark', number>> = {};
    for (const entry of byChannel) {
      if (entry.channel === 'desktop' || entry.channel === 'lark') {
        channelSummary[entry.channel] = entry._count._all;
      }
    }
    const modeSummary: Partial<Record<'fast' | 'high' | 'xtreme' | 'unknown', number>> = {};
    for (const entry of byMode) {
      const key = entry.mode === 'fast' || entry.mode === 'high' || entry.mode === 'xtreme'
        ? entry.mode
        : 'unknown';
      modeSummary[key] = entry._count._all;
    }

    return {
      items: items.map(mapRun) as ExecutionRunListItemDTO[],
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      summary: {
        totalRuns: total,
        failedRuns: statusCounts.get('failed') ?? 0,
        activeRuns: statusCounts.get('running') ?? 0,
        byChannel: channelSummary,
        byMode: modeSummary,
      },
    };
  }

  async getInsights(scope: ExecutionRunScope, filters: ExecutionRunFiltersDTO): Promise<ExecutionInsightsResponse> {
    const runWhere: Prisma.ExecutionRunWhereInput = {
      AND: [
        buildScopeWhere(scope),
        buildFilterWhere(filters),
      ],
    };

    const events = await this.repository.listInsightEvents({
      runWhere,
      eventTypes: [EXECUTION_TOOL_DEMAND_EVENT, EXECUTION_CAPABILITY_GAP_EVENT],
    });

    const demandBuckets = new Map<string, {
      family: string;
      count: number;
      users: Set<string>;
      queries: Set<string>;
      channels: Partial<Record<'desktop' | 'lark', number>>;
    }>();
    const gapBuckets = new Map<string, {
      gapKey: string;
      label: string;
      family: string;
      count: number;
      users: Set<string>;
      queries: Set<string>;
      reasons: Set<string>;
      channels: Partial<Record<'desktop' | 'lark', number>>;
    }>();

    for (const row of events) {
      if (row.eventType === EXECUTION_TOOL_DEMAND_EVENT) {
        const payload = coerceDemandPayload(row.payload);
        if (!payload) continue;
        const bucket = demandBuckets.get(payload.intendedToolFamily) ?? {
          family: payload.intendedToolFamily,
          count: 0,
          users: new Set<string>(),
          queries: new Set<string>(),
          channels: {},
        };
        bucket.count += 1;
        if (row.execution.userId) bucket.users.add(row.execution.userId);
        bucket.queries.add(payload.userQuery);
        const channel = asExecutionChannel(row.execution.channel) ?? payload.channel;
        bucket.channels[channel] = (bucket.channels[channel] ?? 0) + 1;
        demandBuckets.set(payload.intendedToolFamily, bucket);
        continue;
      }

      if (row.eventType === EXECUTION_CAPABILITY_GAP_EVENT) {
        const payload = coerceGapPayload(row.payload);
        if (!payload) continue;
        const bucket = gapBuckets.get(payload.gapKey) ?? {
          gapKey: payload.gapKey,
          label: payload.gapLabel,
          family: payload.intendedToolFamily,
          count: 0,
          users: new Set<string>(),
          queries: new Set<string>(),
          reasons: new Set<string>(),
          channels: {},
        };
        bucket.count += 1;
        if (row.execution.userId) bucket.users.add(row.execution.userId);
        bucket.queries.add(payload.userQuery);
        const reason = payload.errorMessage || payload.validationFailureReason || payload.selectionReason;
        if (reason) bucket.reasons.add(reason);
        const channel = asExecutionChannel(row.execution.channel) ?? payload.channel;
        bucket.channels[channel] = (bucket.channels[channel] ?? 0) + 1;
        gapBuckets.set(payload.gapKey, bucket);
      }
    }

    const topDemandedFamilies: ExecutionDemandInsightDTO[] = Array.from(demandBuckets.values())
      .sort((left, right) => right.count - left.count || right.users.size - left.users.size || left.family.localeCompare(right.family))
      .slice(0, 8)
      .map((bucket) => ({
        family: bucket.family,
        demandCount: bucket.count,
        uniqueUsers: bucket.users.size,
        sampleQueries: takeSampleQueries(bucket.queries),
        channels: bucket.channels,
      }));

    const topCapabilityGaps: ExecutionCapabilityGapInsightDTO[] = Array.from(gapBuckets.values())
      .sort((left, right) => right.count - left.count || right.users.size - left.users.size || left.label.localeCompare(right.label))
      .slice(0, 8)
      .map((bucket) => ({
        gapKey: bucket.gapKey,
        label: bucket.label,
        family: bucket.family,
        gapCount: bucket.count,
        uniqueUsers: bucket.users.size,
        sampleQueries: takeSampleQueries(bucket.queries),
        reasons: takeSampleQueries(bucket.reasons),
        channels: bucket.channels,
      }));

    return {
      topDemandedFamilies,
      topCapabilityGaps,
    };
  }

  async listRunEvents(
    scope: ExecutionRunScope,
    executionId: string,
    input?: {
      phase?: ExecutionPhase;
      actorType?: ExecutionActorType;
    },
  ): Promise<ExecutionEventListResponse> {
    await this.getRun(scope, executionId);
    const visibility = resolvePayloadVisibility(scope);
    const items = await this.repository.listEvents({
      where: { executionId },
      phase: input?.phase,
      actorType: input?.actorType,
    });
    return {
      items: items.map((item) => mapEvent(item, visibility)),
    };
  }

  async listStepResults(executionId: string): Promise<StepResultRow[]> {
    return stepResultRepository.listStepResults(executionId);
  }
}

export const executionService = new ExecutionService();
