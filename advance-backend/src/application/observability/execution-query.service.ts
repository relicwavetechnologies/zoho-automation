/**
 * ExecutionQueryService — role-scoped read access to execution run data.
 *
 * Visibility rules:
 *   COMPANY_ADMIN and SUPER_ADMIN → see full payload (everything except
 *                                    NEVER_PERSIST_KEYS already stripped at write time)
 *   Other roles                   → payload key subset (REDACTED_VIEW_KEYS
 *                                    removed from events)
 *
 * All queries are company-scoped: a caller can only read runs for their own
 * companyId. The service never returns data across company boundaries.
 */

import type { ExecutionRepository, ExecutionRunView, ExecutionEventView, RunStatsRow } from '../../infrastructure/persistence/execution.repository';
import type { Logger } from '../../shared/logger';
import { costUsd } from './pricing';
import { attributeLatency, type LatencyAttribution } from './latency-attribution';
import { sanitizeLatencyAttributes } from './run-latency-recorder';

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Keys inside `ExecutionEvent.payload` that are hidden from callers without
 * raw execution-data access. These may contain prompts, history, or other LLM
 * internals.
 */
const REDACTED_VIEW_KEYS = new Set([
  'prompt', 'systemPrompt', 'history', 'historyContext', 'memoryContext',
  'requestContext', 'fullPrompt', 'toolInput', 'inputMessages',
  'modelInput', 'toolCall',
]);

function redactPayload(payload: unknown, canViewRawExecutionData: boolean): unknown {
  if (canViewRawExecutionData) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (REDACTED_VIEW_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ─── View DTOs ────────────────────────────────────────────────────────────────

interface RunBaseDto {
  id:            string;
  status:        string;
  channel:       string;
  entrypoint:    string;
  latestSummary: string | null;
  errorCode:     string | null;
  errorMessage:  string | null;
  startedAt:     string;
  finishedAt:    string | null;
  durationMs:    number | null;
}

export interface RunSummaryDto extends RunBaseDto {
  userId:   string | null;
  userName: string | null;   // resolved display name (or email fallback)
  turns:    number;          // model calls in the run
  tokens:   number;          // input + output tokens
  costUsd:  number | null;   // provider-reported cost (null when unattributed)
}

export interface RunDetailDto extends RunSummaryDto {
  threadId:    string | null;
  chatId:      string | null;
  agentTarget: string | null;
}

export interface EventDto {
  id:        string;
  sequence:  number;
  phase:     string;
  eventType: string;
  actorType: string;
  actorKey:  string | null;
  title:     string;
  summary:   string | null;
  status:    string | null;
  payload:   unknown;
  sourceTimestamp: string | null;
  createdAt: string;
}

export interface LatencySummaryDto extends LatencyAttribution {
  executionId: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface ExecutionQueryServiceDeps {
  repo:   ExecutionRepository;
  logger: Logger;
}

export class ExecutionQueryService {
  constructor(private readonly deps: ExecutionQueryServiceDeps) {}

  /** List recent runs for the caller's company. */
  async listRuns(input: {
    companyId:    string;
    limit?:       number;
    offset?:      number;
    userId?:      string;
    status?:      string;
    channel?:     string;
  }): Promise<RunSummaryDto[]> {
    const runs = await this.deps.repo.listByCompany({
      companyId: input.companyId,
      limit:     Math.min(input.limit ?? 50, 200),
      offset:    input.offset ?? 0,
      ...(input.userId  ? { userId:  input.userId }  : {}),
      ...(input.status  ? { status:  input.status }  : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    });

    const [stats, users] = await Promise.all([
      this.deps.repo.aggregateRunStats(runs.map(r => r.id)),
      this.deps.repo.resolveUsers(runs.map(r => r.userId).filter((x): x is string => Boolean(x))),
    ]);

    return runs.map(r => this.enrich(r, stats, users));
  }

  /** Get a single run's detail (includes userId, chatId, etc.). */
  async getRun(input: {
    id:           string;
    companyId:    string;
  }): Promise<RunDetailDto | null> {
    const run = await this.deps.repo.findById(input.id, input.companyId);
    if (!run) return null;

    const [stats, users] = await Promise.all([
      this.deps.repo.aggregateRunStats([run.id]),
      run.userId ? this.deps.repo.resolveUsers([run.userId]) : Promise.resolve(new Map()),
    ]);

    return {
      ...this.enrich(run, stats, users),
      threadId:    run.threadId,
      chatId:      run.chatId,
      agentTarget: run.agentTarget,
    };
  }

  /** Get ordered event stream for a run, with role-based payload redaction. */
  async getEvents(input: {
    executionId:  string;
    companyId:    string;
    canViewRawExecutionData: boolean;
    phase?:       string;
    limit?:       number;
  }): Promise<EventDto[]> {
    const events = await this.deps.repo.listEvents({
      executionId: input.executionId,
      companyId:   input.companyId,
      limit:       Math.min(input.limit ?? 500, 1000),
      ...(input.phase ? { phase: input.phase } : {}),
    });

    return events.map(e => this.toEventDto(e, input.canViewRawExecutionData));
  }

  /** Ranked, non-double-counted latency attribution for one company-owned run. */
  async getLatencySummary(input: {
    executionId: string;
    companyId: string;
  }): Promise<LatencySummaryDto | null> {
    const run = await this.deps.repo.findById(input.executionId, input.companyId);
    if (!run) return null;
    const spans = await this.deps.repo.listSpans({
      executionId: input.executionId,
      companyId: input.companyId,
      limit: 5_000,
    });
    return {
      executionId: input.executionId,
      ...attributeLatency(spans.map(span => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        category: span.category,
        source: span.source,
        startedAtMs: span.startedAt.getTime(),
        endedAtMs: span.endedAt.getTime(),
        status: span.status,
        ...latencyAttributes(span.attributes),
      }))),
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private toBase(run: ExecutionRunView): RunBaseDto {
    const durationMs = run.finishedAt
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;

    return {
      id:            run.id,
      status:        run.status,
      channel:       run.channel,
      entrypoint:    run.entrypoint,
      latestSummary: run.latestSummary,
      errorCode:     run.errorCode,
      errorMessage:  run.errorMessage,
      startedAt:     run.startedAt.toISOString(),
      finishedAt:    run.finishedAt?.toISOString() ?? null,
      durationMs,
    };
  }

  /** Fold per-run stats + resolved user onto the base run shape (cost priced from tokens). */
  private enrich(
    run: ExecutionRunView,
    stats: Map<string, RunStatsRow>,
    users: Map<string, { name: string | null; email: string }>,
  ): RunSummaryDto {
    const s = stats.get(run.id);
    const u = run.userId ? users.get(run.userId) : undefined;
    let tokens = 0;
    let cost = 0;
    for (const m of s?.models ?? []) {
      tokens += m.missIn + m.out;
      cost += costUsd(m.modelId, { cacheMissIn: m.missIn, cacheHitIn: m.hitIn, output: m.out });
    }
    return {
      ...this.toBase(run),
      userId:   run.userId,
      userName: u?.name ?? u?.email ?? null,
      turns:    s?.turns ?? 0,
      tokens,
      costUsd:  s && s.models.length > 0 ? cost : null,
    };
  }

  private toEventDto(event: ExecutionEventView, canViewRawExecutionData: boolean): EventDto {
    return {
      id:        event.id,
      sequence:  event.sequence,
      phase:     event.phase,
      eventType: event.eventType,
      actorType: event.actorType,
      actorKey:  event.actorKey,
      title:     event.title,
      summary:   event.summary,
      status:    event.status,
      payload:   redactPayload(event.payload, canViewRawExecutionData),
      sourceTimestamp: event.sourceTimestamp?.toISOString() ?? null,
      createdAt: event.createdAt.toISOString(),
    };
  }
}

function latencyAttributes(value: unknown): {
  attributes?: Record<string, string | number | boolean | null>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidates = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string | number | boolean | null] => (
        entry[1] === null
        || ['string', 'number', 'boolean'].includes(typeof entry[1])
      ))
      .slice(0, 20),
  );
  const attributes = sanitizeLatencyAttributes(candidates);
  return Object.keys(attributes).length > 0 ? { attributes } : {};
}
