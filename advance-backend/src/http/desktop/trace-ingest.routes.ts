/**
 * Trace ingest routes — desktop/PI run-trace capture (Track A).
 *
 * Mounted at /api/desktop/trace behind member auth. The Jan/PI runtime drives
 * the agent loop locally; it batches tool/model/boundary events per turn and
 * fire-and-forget POSTs them here. We persist them into the existing
 * ExecutionRun / ExecutionEvent / StepResult / AiTokenUsage models so the admin
 * viewer, retention job, and cost pipeline apply uniformly to desktop runs.
 *
 *   POST /   — ingest a batch of run events
 *
 * companyId/userId come from the member session (res.locals). Writes are
 * awaited (durability) but each event failure is swallowed and logged so a
 * single bad event never rejects the batch. PI never awaits the response, so
 * backend write latency does not affect the user-facing turn.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { ExecutionRepository } from '../../infrastructure/persistence/execution.repository';
import { TokenUsageService } from '../../application/observability/token-usage.service';
import { PersonaLearningService } from '../../application/persona-learning/persona-learning.service';
import type { PersonaLearningToolSummary } from '../../application/persona-learning/persona-learning.types';
import type { KnowledgeLearningService } from '../../application/knowledge/knowledge-learning.service';
import { isProtectedShopifyToolId } from '../../application/shopify/shopify-protected-result';
import { RUNTIME_CHANNELS, type RuntimeChannel } from '../../domain/channel/runtime-channel';

export interface TraceIngestRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
  /** Legacy kill switch for clients that do not declare per-batch usage ownership. */
  proxyOwnsTrace?: boolean;
  /** Optional until P1–P3 is deployed with the persona-learning worker. */
  personaLearning?: PersonaLearningService;
  /** Personal-only learning capture. Identity comes from member auth, never Pi. */
  knowledgeLearning?: Pick<KnowledgeLearningService, 'captureCompletedTurn'>;
}

// ─── Contract (shared shape PI emits) ───────────────────────────────────────

const usageSchema = z.object({
  input:      z.number().nonnegative().optional(),
  output:     z.number().nonnegative().optional(),
  cacheRead:  z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  cost:       z.number().nonnegative().optional(),
});

const jsonValue = z.unknown();

const eventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind:      z.literal('tool'),
    seq:       z.number().int().nonnegative(),
    ts:        z.number().optional(),
    toolName:  z.string().min(1).max(200),
    input:     jsonValue.optional(),
    output:    jsonValue.optional(),
    isError:   z.boolean().optional(),
    summary:   z.string().max(2000).optional(),
  }),
  z.object({
    kind:        z.literal('model'),
    seq:         z.number().int().nonnegative(),
    ts:          z.number().optional(),
    provider:    z.string().min(1).max(100),
    model:       z.string().min(1).max(200),
    responseId:  z.string().max(200).optional(),
    agentTarget: z.string().max(200).optional(),
    mode:        z.string().max(50).optional(),
    usage:       usageSchema.optional(),
  }),
  z.object({
    kind:    z.enum(['run_start', 'run_end', 'turn_start', 'turn_end']),
    seq:     z.number().int().nonnegative(),
    ts:      z.number().optional(),
    title:   z.string().max(300).optional(),
    summary: z.string().max(2000).optional(),
    status:  z.enum(['ok', 'error']).optional(),
  }),
  z.object({
    kind: z.literal('learning_context'),
    seq: z.number().int().nonnegative(),
    ts: z.number().optional(),
    userMessages: z.array(z.string().max(4_000)).max(12),
    assistantResponse: z.string().max(6_000).optional(),
    toolSummary: z.array(z.object({
      toolName: z.string().min(1).max(200),
      isError: z.boolean(),
      summary: z.string().max(500).optional(),
    }).strict()).max(20),
  }),
]);

const batchSchema = z.object({
  runId:       z.string().min(1).max(200),
  sessionId:   z.string().max(200).optional(),
  threadId:    z.string().max(200).optional(),
  agentTarget: z.string().max(200).optional(),
  // A backend-driven run owns private-learning capture at its own boundary,
  // because only that boundary knows whether the source was a human-authored
  // private turn. Trace ingest still stores the full timeline but must not learn
  // it again. Absent means a desktop run, which has no such boundary.
  runtimeChannel: z.enum(RUNTIME_CHANNELS).optional(),
  usageAuthority: z.enum(['desktop', 'proxy']).default('desktop'),
  // Conservative client observation: it may only increase redaction. Exact
  // gateway tool envelopes remain the server's classification authority.
  protectedDataObserved: z.literal(true).optional(),
  events:      z.array(eventSchema).min(1).max(500),
});

type TraceEvent = z.infer<typeof eventSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

const RAW_CAP   = 16_000; // per-field cap for the raw StepResult store
const PREVIEW_CAP = 2_000; // per-field cap for the event-timeline preview

/** Serialise + size-cap an arbitrary value for storage. */
function capValue(value: unknown, cap: number): unknown {
  if (value === undefined || value === null) return value ?? null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= cap) return value;
  return { _truncated: true, _bytes: text.length, preview: text.slice(0, cap) };
}

// ─── Ingest core (exported for testing) ─────────────────────────────────────

export type TraceBatch = z.infer<typeof batchSchema>;

export interface TraceIdentity {
  companyId: string;
  userId:    string;
  companyRole: string;
}

export interface BackendTraceProvenance {
  readonly runId: string;
  readonly executionId?: string;
  readonly backendIssued: true;
}

export interface IngestResult {
  executionId: string;
  accepted:    number;
  failed:      number;
}

/**
 * Admit learning only for a run the backend has already established.
 *
 * Desktop run IDs originate in the local Pi lifecycle, so existence alone is
 * not enough: a desktop run must already have authoritative proxy model usage
 * while it is still live. Lark runs instead use the exact backend-issued Pi
 * lease run ID. Trace ingestion never mints learning authority from the body.
 */
export async function resolveBackendTraceProvenance(
  prisma: Pick<PrismaClient, 'executionRun' | 'aiTokenUsage'>,
  identity: TraceIdentity,
  input: {
    readonly runId: string;
    readonly runtimeChannel?: RuntimeChannel;
    readonly runtimeRunId?: string;
    readonly runtimeThreadId?: string;
    readonly threadId?: string;
  },
): Promise<BackendTraceProvenance | null> {
  if (input.runtimeChannel && !input.runtimeRunId) return null;
  if (input.runtimeRunId && input.runId !== input.runtimeRunId) return null;
  if (input.runtimeThreadId && input.threadId && input.runtimeThreadId !== input.threadId) return null;

  const expectedChannel = input.runtimeChannel ?? 'desktop';
  const run = await prisma.executionRun.findUnique({
    where: { requestId: input.runId },
    select: {
      id: true,
      companyId: true,
      userId: true,
      channel: true,
      entrypoint: true,
      status: true,
    },
  });

  if (run) {
    if (
      run.companyId !== identity.companyId
      || run.userId !== identity.userId
      || run.channel !== expectedChannel
      || run.entrypoint !== 'pi'
      || run.status !== 'running'
    ) return null;

    if (input.runtimeRunId) {
      return { runId: input.runId, executionId: run.id, backendIssued: true };
    }

    const usage = await prisma.aiTokenUsage.findFirst({
      where: {
        executionRunId: run.id,
        companyId: identity.companyId,
        userId: identity.userId,
        channel: 'desktop',
      },
      select: { id: true },
    });
    if (!usage) return null;
    return { runId: input.runId, executionId: run.id, backendIssued: true };
  }

  // A valid runtime lease is itself backend-issued provenance. The run may
  // not have been persisted yet when the first Lark trace batch races it.
  return input.runtimeRunId
    ? { runId: input.runId, backendIssued: true }
    : null;
}

/**
 * Persist one validated trace batch. Idempotent per runId (upsert on requestId
 * + per-(run,sequence) event upserts), so retried batches are safe. A single
 * event failure never sinks the batch.
 */
export async function ingestTraceBatch(
  runs: ExecutionRepository,
  tokens: TokenUsageService,
  log: Logger,
  identity: TraceIdentity,
  batch: TraceBatch,
  personaLearning?: PersonaLearningService,
  knowledgeLearning?: Pick<KnowledgeLearningService, 'captureCompletedTurn'>,
  provenance?: BackendTraceProvenance,
): Promise<IngestResult> {
  const batchContainsProtectedShopifyData = batch.protectedDataObserved === true
    || batch.events.some(isProtectedShopifyTraceEvent);
  const executionId = provenance?.executionId ?? await runs.findOrCreateByRequestId({
    requestId:  batch.runId,
    companyId:  identity.companyId,
    userId:     identity.userId,
    channel:    batch.runtimeChannel ?? 'desktop',
    entrypoint: 'pi',
    ...(batch.threadId    ? { threadId:    batch.threadId }    : {}),
    ...(batch.sessionId   ? { chatId:      batch.sessionId }   : {}),
    ...(batch.agentTarget ? { agentTarget: batch.agentTarget } : {}),
  });
  const containsProtectedShopifyData = await runs.observeProtectedData(
    executionId,
    batchContainsProtectedShopifyData,
  );

  const ctx = {
    executionId,
    companyId: identity.companyId,
    userId:    identity.userId,
    ...(batch.agentTarget !== undefined ? { agentTarget: batch.agentTarget } : {}),
    ...(batch.threadId    !== undefined ? { threadId:    batch.threadId }    : {}),
  };
  const fallbackRunSummary = firstUserMessageTitle(batch.events);

  const results = await Promise.allSettled(
    batch.events.map((ev) => persistEvent(
      runs,
      tokens,
      ev,
      ctx,
      batch.usageAuthority,
      containsProtectedShopifyData,
      fallbackRunSummary,
    )),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    log.warn('trace-ingest.partial', { runId: batch.runId, failed, total: batch.events.length });
  }
  if (provenance?.backendIssued && !containsProtectedShopifyData) {
    await Promise.all([
      capturePersonaLearningEvidence(personaLearning, log, {
        executionId,
        companyId: identity.companyId,
        userId: identity.userId,
        ...(batch.threadId ? { threadId: batch.threadId } : {}),
        events: batch.events,
      }),
      capturePersonalLearning(batch.runtimeChannel ? undefined : knowledgeLearning, log, {
        executionId,
        companyId: identity.companyId,
        userId: identity.userId,
        companyRole: identity.companyRole,
        events: batch.events,
      }),
    ]);
  }
  return { executionId, accepted: batch.events.length - failed, failed };
}

async function capturePersonalLearning(
  knowledgeLearning: Pick<KnowledgeLearningService, 'captureCompletedTurn'> | undefined,
  log: Logger,
  input: {
    executionId: string;
    companyId: string;
    userId: string;
    companyRole: string;
    events: readonly TraceEvent[];
  },
): Promise<void> {
  if (!knowledgeLearning) return;
  const terminalEvent = findLast(input.events, event => event.kind === 'run_end');
  const contextEvent = findLast(input.events, event => event.kind === 'learning_context');
  if (terminalEvent?.kind !== 'run_end' || contextEvent?.kind !== 'learning_context') return;
  if (terminalEvent.status !== 'ok' || !contextEvent.assistantResponse) return;

  const userMessages = contextEvent.userMessages.map(message => message.trim()).filter(Boolean);
  if (userMessages.length === 0) return;

  try {
    await knowledgeLearning.captureCompletedTurn({
      companyId: input.companyId,
      userId: input.userId,
      companyRole: input.companyRole,
      channel: 'desktop',
      userMessages,
      assistantText: contextEvent.assistantResponse,
      sourceId: `desktop:${input.executionId}`,
    });
  } catch (error) {
    // Personal memory is advisory. A provider failure must not reject or retry
    // an otherwise durable execution trace.
    log.warn('trace-ingest.personal-learning.capture_failed', {
      executionId: input.executionId,
      error: String(error),
    });
  }
}

async function persistEvent(
  runs: ExecutionRepository,
  tokens: TokenUsageService,
  ev: TraceEvent,
  ctx: { executionId: string; companyId: string; userId: string; agentTarget?: string; threadId?: string },
  usageAuthority: 'desktop' | 'proxy',
  protectedRun: boolean,
  fallbackRunSummary?: string,
): Promise<void> {
  if (ev.kind === 'tool') {
      const success = ev.isError !== true;
      const protectedShopify = protectedShopifyTraceMetadata(ev);
      const storedInput = protectedShopify ?? capValue(ev.input, PREVIEW_CAP);
      const storedOutput = protectedShopify
        ? '[REDACTED: governed Shopify protected-data result]'
        : capValue(ev.output, PREVIEW_CAP);
      await runs.appendEvent({
        executionId: ctx.executionId,
        sequence:    ev.seq,
        phase:       'execute',
        eventType:   'tool_result',
        actorType:   'tool',
        actorKey:    ev.toolName,
        title:       ev.toolName,
        status:      success ? 'ok' : 'error',
        ...(protectedShopify
          ? { summary: 'Protected Shopify result redacted' }
          : ev.summary ? { summary: ev.summary } : {}),
        payload: {
          input: storedInput,
          output: storedOutput,
          isError: ev.isError ?? false,
        },
      });
      // Raw tool I/O → StepResult (fuller cap; role-gated at read time).
      await runs.appendStepResult({
        executionId: ctx.executionId,
        sequence:    ev.seq,
        toolName:    ev.toolName,
        actorKey:    ev.toolName,
        success,
        status:      success ? 'ok' : 'error',
        ...(protectedShopify
          ? { summary: 'Protected Shopify result redacted' }
          : ev.summary ? { summary: ev.summary } : {}),
        rawOutput: {
          input: protectedShopify ?? capValue(ev.input, RAW_CAP),
          output: protectedShopify
            ? '[REDACTED: governed Shopify protected-data result]'
            : capValue(ev.output, RAW_CAP),
        },
      });
      return;
    }

    if (ev.kind === 'model') {
      await runs.appendEvent({
        executionId: ctx.executionId,
        sequence:    ev.seq,
        phase:       'model',
        eventType:   'model_call',
        actorType:   'model',
        actorKey:    ev.model,
        title:       ev.model,
        status:      'ok',
        payload: {
          provider:   ev.provider,
          model:      ev.model,
          ...(ev.responseId ? { responseId: ev.responseId } : {}),
          ...(ev.usage ? { usage: ev.usage } : {}),
        },
      });
      // Token attribution → AiTokenUsage (Track B foundation).
      const u = ev.usage;
      if (u && usageAuthority === 'desktop') {
        await tokens.recordForRun({
          executionRunId: ctx.executionId,
          companyId:      ctx.companyId,
          userId:         ctx.userId,
          agentTarget:    ev.agentTarget ?? ctx.agentTarget ?? 'pi',
          modelId:        ev.model,
          provider:       ev.provider,
          channel:        'desktop',
          ...(ctx.threadId  !== undefined ? { threadId: ctx.threadId } : {}),
          ...(ev.mode        !== undefined ? { mode: ev.mode }         : {}),
          ...(u.input        !== undefined ? { actualInputTokens:     u.input }      : {}),
          ...(u.output       !== undefined ? { actualOutputTokens:    u.output }     : {}),
          ...(u.cacheRead    !== undefined ? { cacheReadInputTokens:  u.cacheRead }  : {}),
          ...(u.cacheWrite   !== undefined ? { cacheWriteInputTokens: u.cacheWrite } : {}),
          ...(u.cost         !== undefined ? { reportedCostUsd:       u.cost }       : {}),
        });
      }
      return;
    }

    if (ev.kind === 'learning_context') {
      // Evidence itself is stored in the isolated long-lived persona-learning
      // table. The trace timeline records only compact metadata, not excerpts.
      await runs.appendEvent({
        executionId: ctx.executionId,
        sequence: ev.seq,
        phase: 'learning',
        eventType: 'learning_context',
        actorType: 'engine',
        title: 'Manager learning context captured',
        status: 'ok',
        payload: {
          userMessageCount: ev.userMessages.length,
          hasAssistantResponse: Boolean(ev.assistantResponse),
          toolCount: ev.toolSummary.length,
        },
      });
      return;
    }

    // Boundary events (run/turn start/end).
    await runs.appendEvent({
      executionId: ctx.executionId,
      sequence:    ev.seq,
      phase:       ev.kind.startsWith('run') ? 'run' : 'turn',
      eventType:   ev.kind,
      actorType:   'engine',
      title:       ev.title ?? ev.kind,
      ...(protectedRun
        ? { summary: 'Protected Shopify run summary redacted' }
        : ev.summary ? { summary: ev.summary } : {}),
      ...(ev.status  ? { status:  ev.status }  : {}),
    });

    if (ev.kind === 'run_end') {
      if (ev.status === 'error') {
        await runs.fail(
          ctx.executionId,
          'pi_run_error',
          protectedRun ? 'Protected Shopify run failed; details redacted' : ev.summary ?? 'Run failed',
        );
      } else {
        await runs.complete(
          ctx.executionId,
          protectedRun ? 'Protected Shopify run completed; details redacted' : ev.summary ?? fallbackRunSummary,
        );
      }
    }
}

/**
 * Desktop traces are client-authored diagnostics, not an authority for data
 * classification. Recognize only the closed gateway envelope and let the
 * backend tool ID decide whether result content must be suppressed.
 */
function protectedShopifyTraceMetadata(
  event: TraceEvent,
): { readonly provider: 'shopify'; readonly toolId: string; readonly operation: string | null; readonly connectionId: string | null } | null {
  if (event.kind !== 'tool' || event.toolName !== 'divo_gateway') return null;
  const input = asRecord(event.input);
  if (input?.['op'] !== 'tools.invoke') return null;
  const payload = asRecord(input['payload']);
  const toolId = payload?.['toolId'];
  if (typeof toolId !== 'string' || !isProtectedShopifyToolId(toolId)) return null;
  const args = asRecord(payload?.['args']);
  return {
    provider: 'shopify',
    toolId,
    operation: typeof args?.['operation'] === 'string' ? args['operation'] : null,
    connectionId: typeof args?.['connectionId'] === 'string' ? args['connectionId'] : null,
  };
}

function isProtectedShopifyTraceEvent(event: TraceEvent): boolean {
  return protectedShopifyTraceMetadata(event) !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function capturePersonaLearningEvidence(
  personaLearning: PersonaLearningService | undefined,
  log: Logger,
  input: {
    executionId: string;
    companyId: string;
    userId: string;
    threadId?: string;
    events: readonly TraceEvent[];
  },
): Promise<void> {
  if (!personaLearning) return;
  const terminalEvent = findLast(input.events, event => event.kind === 'run_end');
  const contextEvent = findLast(input.events, event => event.kind === 'learning_context');
  if (terminalEvent?.kind !== 'run_end' || contextEvent?.kind !== 'learning_context') return;
  const terminal = terminalEvent as { kind: 'run_end'; status?: 'ok' | 'error'; summary?: string };
  const context = contextEvent as {
    kind: 'learning_context';
    userMessages: string[];
    assistantResponse?: string;
    toolSummary: PersonaLearningToolSummary[];
  };
  if (terminal.status === 'error') return;

  try {
    await personaLearning.captureCompletedManagerRun({
      executionRunId: input.executionId,
      companyId: input.companyId,
      managerId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(terminal.summary ? { runSummary: terminal.summary } : {}),
      context: {
        userMessages: context.userMessages,
        ...(context.assistantResponse ? { assistantResponse: context.assistantResponse } : {}),
      },
      tools: context.toolSummary,
    });
  } catch (error) {
    // Learning must never make desktop trace persistence fail. The trace still
    // provides enough observability to diagnose a capture failure.
    log.warn('trace-ingest.persona-learning.capture_failed', {
      executionId: input.executionId,
      error: String(error),
    });
  }
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (predicate(item)) return item;
  }
  return undefined;
}

function firstUserMessageTitle(events: readonly TraceEvent[]): string | undefined {
  const context = events.find((event): event is Extract<TraceEvent, { kind: 'learning_context' }> =>
    event.kind === 'learning_context');
  const message = context?.userMessages.find(entry => entry.trim().length > 0);
  if (!message) return undefined;
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function createTraceIngestRoutes(deps: TraceIngestRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'trace-ingest' });
  const runs = new ExecutionRepository(deps.prisma);
  const tokens = new TokenUsageService(deps.prisma, deps.logger);

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const companyId = res.locals['companyId'] as string | undefined;
    const userId    = res.locals['userId'] as string | undefined;
    const companyRole = res.locals['aiRole'] as string | undefined;
    if (!companyId || !userId || !companyRole) {
      res.status(401).json({ success: false, message: 'Unauthenticated' });
      return;
    }

    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? 'Invalid batch' });
      return;
    }

    // Legacy clients do not declare ownership. Preserve the deployment kill
    // switch before provenance lookup: this path stores nothing and cannot
    // invoke either learning pipeline.
    if (deps.proxyOwnsTrace && parsed.data.usageAuthority === 'desktop') {
      res.status(202).json({ success: true, data: { skipped: true } });
      return;
    }

    let provenance: BackendTraceProvenance | null;
    try {
      provenance = await resolveBackendTraceProvenance(
        deps.prisma,
        { companyId, userId, companyRole },
        {
          runId: parsed.data.runId,
          ...(parsed.data.runtimeChannel ? { runtimeChannel: parsed.data.runtimeChannel } : {}),
          ...(res.locals['runtimeRunId'] ? { runtimeRunId: res.locals['runtimeRunId'] as string } : {}),
          ...(res.locals['runtimeThreadId'] ? { runtimeThreadId: res.locals['runtimeThreadId'] as string } : {}),
          ...(parsed.data.threadId ? { threadId: parsed.data.threadId } : {}),
        },
      );
    } catch (error) {
      log.error('trace-ingest.provenance_check_failed', { runId: parsed.data.runId, error: String(error) });
      res.status(503).json({
        success: false,
        code: 'trace_provenance_unavailable',
        message: 'Execution provenance is temporarily unavailable. Please retry.',
      });
      return;
    }
    if (!provenance) {
      res.status(403).json({
        success: false,
        code: 'trace_provenance_required',
        message: 'Trace was not issued by an active Divo execution.',
      });
      return;
    }

    try {
      const result = await ingestTraceBatch(
        runs,
        tokens,
        log,
        { companyId, userId, companyRole },
        parsed.data,
        deps.personaLearning,
        deps.knowledgeLearning,
        provenance,
      );
      res.status(202).json({ success: true, data: result });
    } catch (e) {
      log.error('trace-ingest.failed', { runId: parsed.data.runId, error: String(e) });
      res.status(500).json({ success: false, message: 'Could not persist trace' });
    }
  });

  return router;
}
