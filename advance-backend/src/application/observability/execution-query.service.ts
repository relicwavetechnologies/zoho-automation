/**
 * ExecutionQueryService — role-scoped read access to execution run data.
 *
 * Visibility rules (mirrored from old backend):
 *   SUPER_ADMIN  → sees full payload (everything except NEVER_PERSIST_KEYS
 *                  already stripped at write time)
 *   Other roles  → payload key subset (REDACTED_VIEW_KEYS removed from events)
 *
 * All queries are company-scoped: a caller can only read runs for their own
 * companyId. The service never returns data across company boundaries.
 */

import type { ExecutionRepository, ExecutionRunView, ExecutionEventView } from '../../infrastructure/persistence/execution.repository';
import type { Logger } from '../../shared/logger';

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Keys inside `ExecutionEvent.payload` that are hidden from non-SUPER_ADMIN
 * callers. These may contain prompts, history, or other LLM internals.
 */
const REDACTED_VIEW_KEYS = new Set([
  'prompt', 'systemPrompt', 'history', 'historyContext', 'memoryContext',
  'requestContext', 'fullPrompt', 'toolInput', 'inputMessages',
  'modelInput', 'toolCall',
]);

function redactPayload(payload: unknown, isSuperAdmin: boolean): unknown {
  if (isSuperAdmin) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (REDACTED_VIEW_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ─── View DTOs ────────────────────────────────────────────────────────────────

export interface RunSummaryDto {
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

export interface RunDetailDto extends RunSummaryDto {
  userId:      string | null;
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
  createdAt: string;
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
    isSuperAdmin: boolean;
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

    return runs.map(r => this.toSummary(r));
  }

  /** Get a single run's detail (includes userId, chatId, etc.). */
  async getRun(input: {
    id:           string;
    companyId:    string;
    isSuperAdmin: boolean;
  }): Promise<RunDetailDto | null> {
    const run = await this.deps.repo.findById(input.id, input.companyId);
    if (!run) return null;

    return {
      ...this.toSummary(run),
      userId:      run.userId,
      threadId:    run.threadId,
      chatId:      run.chatId,
      agentTarget: run.agentTarget,
    };
  }

  /** Get ordered event stream for a run, with role-based payload redaction. */
  async getEvents(input: {
    executionId:  string;
    companyId:    string;
    isSuperAdmin: boolean;
    phase?:       string;
    limit?:       number;
  }): Promise<EventDto[]> {
    const events = await this.deps.repo.listEvents({
      executionId: input.executionId,
      companyId:   input.companyId,
      limit:       Math.min(input.limit ?? 500, 1000),
      ...(input.phase ? { phase: input.phase } : {}),
    });

    return events.map(e => this.toEventDto(e, input.isSuperAdmin));
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private toSummary(run: ExecutionRunView): RunSummaryDto {
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

  private toEventDto(event: ExecutionEventView, isSuperAdmin: boolean): EventDto {
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
      payload:   redactPayload(event.payload, isSuperAdmin),
      createdAt: event.createdAt.toISOString(),
    };
  }
}
