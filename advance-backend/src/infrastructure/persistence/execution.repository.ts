/**
 * ExecutionRepository — persistence for orchestration run traces.
 *
 * Wraps three Prisma models:
 *   ExecutionRun   — lifecycle record (status, timing, error)
 *   ExecutionEvent — ordered event stream for one run
 *   StepResult     — per-step tool outcome records
 *
 * All writes are fire-and-forget safe: callers should not fail when
 * tracing fails (observability is non-critical path).
 */

import type { PrismaClient } from '../../generated/prisma';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateRunInput {
  companyId:   string;
  userId?:     string;
  channel:     string;
  entrypoint:  string;
  requestId?:  string;
  threadId?:   string;
  chatId?:     string;
  messageId?:  string;
  agentTarget?: string;
}

export interface AppendEventInput {
  executionId: string;
  sequence:    number;
  phase:       string;
  eventType:   string;
  actorType:   string;
  actorKey?:   string;
  title:       string;
  summary?:    string;
  status?:     string;
  payload?:    Record<string, unknown>;
}

export interface AppendStepResultInput {
  executionId:    string;
  sequence:       number;
  toolName:       string;
  actorKey?:      string;
  title?:         string;
  success:        boolean;
  status?:        string;
  summary?:       string;
  resolvedIds?:   Record<string, unknown>;
  rawOutput?:     Record<string, unknown>;
}

// ─── View types ───────────────────────────────────────────────────────────────

export interface ExecutionRunView {
  id:            string;
  companyId:     string;
  userId:        string | null;
  channel:       string;
  entrypoint:    string;
  requestId:     string | null;
  threadId:      string | null;
  chatId:        string | null;
  messageId:     string | null;
  agentTarget:   string | null;
  status:        string;
  latestSummary: string | null;
  errorCode:     string | null;
  errorMessage:  string | null;
  startedAt:     Date;
  finishedAt:    Date | null;
}

export interface ExecutionEventView {
  id:          string;
  executionId: string;
  sequence:    number;
  phase:       string;
  eventType:   string;
  actorType:   string;
  actorKey:    string | null;
  title:       string;
  summary:     string | null;
  status:      string | null;
  payload:     unknown;
  createdAt:   Date;
}

/** Per-run rollup: turn count + per-model cache-split tokens for pricing. */
export interface RunStatsRow {
  turns:  number;
  models: { modelId: string; missIn: number; hitIn: number; out: number }[];
}

// ─── Repository ───────────────────────────────────────────────────────────────

export class ExecutionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Create a new ExecutionRun and return its ID. */
  async create(input: CreateRunInput): Promise<string> {
    const run = await this.prisma.executionRun.create({
      data: {
        companyId:   input.companyId,
        channel:     input.channel,
        entrypoint:  input.entrypoint,
        status:      'running',
        ...(input.userId    ? { userId:     input.userId }    : {}),
        ...(input.requestId ? { requestId:  input.requestId } : {}),
        ...(input.threadId  ? { threadId:   input.threadId }  : {}),
        ...(input.chatId    ? { chatId:     input.chatId }    : {}),
        ...(input.messageId ? { messageId:  input.messageId } : {}),
        ...(input.agentTarget ? { agentTarget: input.agentTarget } : {}),
      },
      select: { id: true },
    });
    return run.id;
  }

  /**
   * Find an ExecutionRun by its external run id (stored as the unique
   * requestId), or create it. Used by the desktop/PI trace ingest path, where
   * PI mints the run id and streams batches per turn — several batches for the
   * same run can arrive concurrently. Prisma's upsert isn't atomic, so racing
   * creates violate the unique requestId; we fast-path the lookup and, on a
   * unique-violation (P2002), re-fetch the row the winning create inserted.
   */
  async findOrCreateByRequestId(input: CreateRunInput & { requestId: string }): Promise<string> {
    const existing = await this.prisma.executionRun.findUnique({
      where:  { requestId: input.requestId },
      select: { id: true, companyId: true, userId: true },
    });
    if (existing) {
      assertRunCorrelationOwner(existing, input);
      return existing.id;
    }

    try {
      const run = await this.prisma.executionRun.create({
        data: {
          companyId:   input.companyId,
          channel:     input.channel,
          entrypoint:  input.entrypoint,
          requestId:   input.requestId,
          status:      'running',
          ...(input.userId      ? { userId:      input.userId }      : {}),
          ...(input.threadId    ? { threadId:    input.threadId }    : {}),
          ...(input.chatId      ? { chatId:      input.chatId }      : {}),
          ...(input.messageId   ? { messageId:   input.messageId }   : {}),
          ...(input.agentTarget ? { agentTarget: input.agentTarget } : {}),
        },
        select: { id: true },
      });
      return run.id;
    } catch (e) {
      // A concurrent batch created the run first — fetch the winner.
      if ((e as { code?: string }).code === 'P2002') {
        const row = await this.prisma.executionRun.findUnique({
          where:  { requestId: input.requestId },
          select: { id: true, companyId: true, userId: true },
        });
        if (row) {
          assertRunCorrelationOwner(row, input);
          return row.id;
        }
      }
      throw e;
    }
  }

  /**
   * Append a structured event to the run's event stream.
   * Sequence numbers are managed by the caller (OrchestrationTracer).
   */
  async appendEvent(input: AppendEventInput): Promise<void> {
    const data = {
      executionId: input.executionId,
      sequence:    input.sequence,
      phase:       input.phase,
      eventType:   input.eventType,
      actorType:   input.actorType,
      title:       input.title,
      ...(input.actorKey ? { actorKey: input.actorKey } : {}),
      ...(input.summary  ? { summary:  input.summary }  : {}),
      ...(input.status   ? { status:   input.status }   : {}),
      ...(input.payload  ? { payload:  input.payload as object } : {}),
    };
    await this.prisma.executionEvent.upsert({
      where:  { executionId_sequence: { executionId: input.executionId, sequence: input.sequence } },
      create: data,
      update: data,
    });
  }

  /** Append a tool-level step result for a run. */
  async appendStepResult(input: AppendStepResultInput): Promise<void> {
    const data = {
      executionId: input.executionId,
      sequence:    input.sequence,
      toolName:    input.toolName,
      success:     input.success,
      ...(input.actorKey    ? { actorKey:    input.actorKey }    : {}),
      ...(input.title       ? { title:       input.title }       : {}),
      ...(input.status      ? { status:      input.status }      : {}),
      ...(input.summary     ? { summary:     input.summary }     : {}),
      ...(input.resolvedIds ? { resolvedIds: input.resolvedIds as object } : {}),
      ...(input.rawOutput   ? { rawOutput:   input.rawOutput as object }   : {}),
    };
    await this.prisma.stepResult.upsert({
      where:  { executionId_sequence: { executionId: input.executionId, sequence: input.sequence } },
      create: data,
      update: data,
    });
  }

  /**
   * Retention (Track A): delete detailed trace payloads older than `cutoff`.
   * Removes ExecutionEvent + StepResult rows; leaves ExecutionRun headers (a
   * cheap long-lived index) and AiTokenUsage (cost/spend history) untouched.
   * Returns how many rows were removed from each table.
   */
  async pruneExpiredDetail(cutoff: Date): Promise<{ events: number; steps: number }> {
    const [events, steps] = await this.prisma.$transaction([
      this.prisma.executionEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.stepResult.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    ]);
    return { events: events.count, steps: steps.count };
  }

  /** Mark a run as completed successfully. */
  async complete(executionId: string, latestSummary?: string): Promise<void> {
    await this.prisma.executionRun.update({
      where: { id: executionId },
      data:  {
        status:     'completed',
        finishedAt: new Date(),
        ...(latestSummary ? { latestSummary } : {}),
      },
    });
  }

  /** Mark a run as failed with an error code + message. */
  async fail(executionId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.prisma.executionRun.update({
      where: { id: executionId },
      data:  {
        status:       'failed',
        finishedAt:   new Date(),
        errorCode,
        errorMessage: errorMessage.slice(0, 2000),
      },
    });
  }

  // ─── Query surface (used by REST layer) ─────────────────────────────────

  /** Fetch a single run by ID, scoped to the caller's companyId. */
  async findById(id: string, companyId: string): Promise<ExecutionRunView | null> {
    const run = await this.prisma.executionRun.findFirst({
      where: { id, companyId },
    });
    return run ?? null;
  }

  /** List recent runs for a company, newest first. */
  async listByCompany(input: {
    companyId: string;
    limit?:    number;
    offset?:   number;
    userId?:   string;
    status?:   string;
    channel?:  string;
  }): Promise<ExecutionRunView[]> {
    return this.prisma.executionRun.findMany({
      where: {
        companyId: input.companyId,
        ...(input.userId  ? { userId:  input.userId }  : {}),
        ...(input.status  ? { status:  input.status }  : {}),
        ...(input.channel ? { channel: input.channel } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take:    input.limit  ?? 50,
      skip:    input.offset ?? 0,
    });
  }

  /**
   * Batch per-run rollups for the list/detail views, keyed by executionId:
   *   turns  — number of model calls (one per turn in the PI loop)
   *   models — per-model cache-split token counts, so the application layer can
   *            price the run (see pricing.ts) rather than trusting reportedCostUsd
   * Two grouped queries, so listing N runs stays O(1) round-trips.
   */
  async aggregateRunStats(
    runIds: string[],
  ): Promise<Map<string, RunStatsRow>> {
    const out = new Map<string, RunStatsRow>();
    if (runIds.length === 0) return out;
    for (const id of runIds) out.set(id, { turns: 0, models: [] });

    const [turnGroups, tokenGroups] = await this.prisma.$transaction([
      this.prisma.executionEvent.groupBy({
        by:      ['executionId'],
        where:   { executionId: { in: runIds }, eventType: 'model_call' },
        _count:  { _all: true },
        orderBy: { executionId: 'asc' },
      }),
      this.prisma.aiTokenUsage.groupBy({
        by:      ['executionRunId', 'modelId'],
        where:   { executionRunId: { in: runIds } },
        _sum:    { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        orderBy: { executionRunId: 'asc' },
      }),
    ]);

    // Prisma's groupBy return typing for _count/_sum is awkward to narrow; the
    // runtime shape is stable, so read it through a precise local cast.
    for (const g of turnGroups as Array<{ executionId: string; _count?: { _all?: number } }>) {
      const e = out.get(g.executionId);
      if (e) e.turns = g._count?._all ?? 0;
    }
    for (const g of tokenGroups as Array<{
      executionRunId: string | null;
      modelId: string;
      _sum?: { actualInputTokens: number | null; cacheReadInputTokens: number | null; actualOutputTokens: number | null };
    }>) {
      if (!g.executionRunId) continue;
      const e = out.get(g.executionRunId);
      if (e) {
        e.models.push({
          modelId: g.modelId,
          missIn:  g._sum?.actualInputTokens ?? 0,
          hitIn:   g._sum?.cacheReadInputTokens ?? 0,
          out:     g._sum?.actualOutputTokens ?? 0,
        });
      }
    }
    return out;
  }

  /** Atomically reserve the next event sequence number for a run. */
  async nextSequence(executionId: string): Promise<number> {
    const run = await this.prisma.executionRun.update({
      where:  { id: executionId },
      data:   { lastSequence: { increment: 1 } },
      select: { lastSequence: true },
    });
    return run.lastSequence;
  }

  /** Resolve userId → display name/email for run attribution (batch, deduped). */
  async resolveUsers(userIds: string[]): Promise<Map<string, { name: string | null; email: string }>> {
    const out = new Map<string, { name: string | null; email: string }>();
    const ids = [...new Set(userIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const users = await this.prisma.user.findMany({
      where:  { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    for (const u of users) out.set(u.id, { name: u.name, email: u.email });
    return out;
  }

  /**
   * Fetch the ordered event stream for a run.
   * `phase` filter is optional (e.g. 'plan', 'execute', 'synthesis').
   */
  async listEvents(input: {
    executionId: string;
    companyId:   string;
    phase?:      string;
    limit?:      number;
  }): Promise<ExecutionEventView[]> {
    // Verify the run belongs to this company first.
    const run = await this.prisma.executionRun.findFirst({
      where: { id: input.executionId, companyId: input.companyId },
      select: { id: true },
    });
    if (!run) return [];

    return this.prisma.executionEvent.findMany({
      where: {
        executionId: input.executionId,
        ...(input.phase ? { phase: input.phase } : {}),
      },
      orderBy: { sequence: 'asc' },
      take:    input.limit ?? 500,
    });
  }
}

function assertRunCorrelationOwner(
  row: { companyId: string; userId: string | null },
  input: { companyId: string; userId?: string },
): void {
  if (row.companyId !== input.companyId || row.userId !== (input.userId ?? null)) {
    throw new Error('Execution run correlation belongs to a different authenticated principal');
  }
}
