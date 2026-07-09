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
   * PI mints the run id and streams events in batches. Returns the run's id.
   */
  async findOrCreateByRequestId(input: CreateRunInput & { requestId: string }): Promise<string> {
    const run = await this.prisma.executionRun.upsert({
      where:  { requestId: input.requestId },
      update: {},
      create: {
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
