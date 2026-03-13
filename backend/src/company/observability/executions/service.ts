import type {
  ExecutionActorType,
  ExecutionEventItemDTO,
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
import type {
  AppendExecutionEventInput,
  CancelExecutionRunInput,
  CompleteExecutionRunInput,
  ExecutionEventListResponse,
  ExecutionRunDetailResponse,
  ExecutionRunListResponse,
  ExecutionRunQuery,
  ExecutionRunScope,
  FailExecutionRunInput,
  StartExecutionRunInput,
} from './types';

const REDACTED_KEYS = new Set([
  'prompt',
  'systemPrompt',
  'history',
  'historyContext',
  'memoryContext',
  'requestContext',
  'rawEvent',
  'rawInput',
  'fullPrompt',
  'reasoning',
  'thinking',
  'thinkingText',
  'cot',
  'chainOfThought',
  'toolInput',
  'inputMessages',
]);

const sanitizePayloadValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 6000 ? `${value.slice(0, 6000)}...` : value;
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

const mapEvent = (row: ExecutionEventRow): ExecutionEventItemDTO => ({
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
  payload: normalizePayload((row.payload ?? null) as Record<string, unknown> | null),
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
    }));
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

  async listRunEvents(
    scope: ExecutionRunScope,
    executionId: string,
    input?: {
      phase?: ExecutionPhase;
      actorType?: ExecutionActorType;
    },
  ): Promise<ExecutionEventListResponse> {
    await this.getRun(scope, executionId);
    const items = await this.repository.listEvents({
      where: { executionId },
      phase: input?.phase,
      actorType: input?.actorType,
    });
    return {
      items: items.map(mapEvent),
    };
  }
}

export const executionService = new ExecutionService();
