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

export interface TraceIngestRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
  /** When the LLM proxy owns the trace + usage, ingest stands down (no double-writes). */
  proxyOwnsTrace?: boolean;
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
]);

const batchSchema = z.object({
  runId:       z.string().min(1).max(200),
  sessionId:   z.string().max(200).optional(),
  threadId:    z.string().max(200).optional(),
  agentTarget: z.string().max(200).optional(),
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
}

export interface IngestResult {
  executionId: string;
  accepted:    number;
  failed:      number;
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
): Promise<IngestResult> {
  const executionId = await runs.findOrCreateByRequestId({
    requestId:  batch.runId,
    companyId:  identity.companyId,
    userId:     identity.userId,
    channel:    'desktop',
    entrypoint: 'pi',
    ...(batch.threadId    ? { threadId:    batch.threadId }    : {}),
    ...(batch.sessionId   ? { chatId:      batch.sessionId }   : {}),
    ...(batch.agentTarget ? { agentTarget: batch.agentTarget } : {}),
  });

  const ctx = {
    executionId,
    companyId: identity.companyId,
    userId:    identity.userId,
    ...(batch.agentTarget !== undefined ? { agentTarget: batch.agentTarget } : {}),
    ...(batch.threadId    !== undefined ? { threadId:    batch.threadId }    : {}),
  };

  const results = await Promise.allSettled(
    batch.events.map((ev) => persistEvent(runs, tokens, ev, ctx)),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    log.warn('trace-ingest.partial', { runId: batch.runId, failed, total: batch.events.length });
  }
  return { executionId, accepted: batch.events.length - failed, failed };
}

async function persistEvent(
  runs: ExecutionRepository,
  tokens: TokenUsageService,
  ev: TraceEvent,
  ctx: { executionId: string; companyId: string; userId: string; agentTarget?: string; threadId?: string },
): Promise<void> {
  if (ev.kind === 'tool') {
      const success = ev.isError !== true;
      await runs.appendEvent({
        executionId: ctx.executionId,
        sequence:    ev.seq,
        phase:       'execute',
        eventType:   'tool_result',
        actorType:   'tool',
        actorKey:    ev.toolName,
        title:       ev.toolName,
        status:      success ? 'ok' : 'error',
        ...(ev.summary ? { summary: ev.summary } : {}),
        payload: {
          input:  capValue(ev.input, PREVIEW_CAP),
          output: capValue(ev.output, PREVIEW_CAP),
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
        ...(ev.summary ? { summary: ev.summary } : {}),
        rawOutput: {
          input:  capValue(ev.input, RAW_CAP),
          output: capValue(ev.output, RAW_CAP),
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
      if (u) {
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

    // Boundary events (run/turn start/end).
    await runs.appendEvent({
      executionId: ctx.executionId,
      sequence:    ev.seq,
      phase:       ev.kind.startsWith('run') ? 'run' : 'turn',
      eventType:   ev.kind,
      actorType:   'engine',
      title:       ev.title ?? ev.kind,
      ...(ev.summary ? { summary: ev.summary } : {}),
      ...(ev.status  ? { status:  ev.status }  : {}),
    });

    if (ev.kind === 'run_end') {
      if (ev.status === 'error') {
        await runs.fail(ctx.executionId, 'pi_run_error', ev.summary ?? 'Run failed');
      } else {
        await runs.complete(ctx.executionId, ev.summary);
      }
    }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function createTraceIngestRoutes(deps: TraceIngestRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'trace-ingest' });
  const runs = new ExecutionRepository(deps.prisma);
  const tokens = new TokenUsageService(deps.prisma, deps.logger);

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    // Proxy owns the trace + authoritative usage — accept & drop PI's self-report.
    if (deps.proxyOwnsTrace) {
      res.status(202).json({ success: true, data: { skipped: true } });
      return;
    }

    const companyId = res.locals['companyId'] as string | undefined;
    const userId    = res.locals['userId'] as string | undefined;
    if (!companyId || !userId) {
      res.status(401).json({ success: false, message: 'Unauthenticated' });
      return;
    }

    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: parsed.error.issues[0]?.message ?? 'Invalid batch' });
      return;
    }

    try {
      const result = await ingestTraceBatch(runs, tokens, log, { companyId, userId }, parsed.data);
      res.status(202).json({ success: true, data: result });
    } catch (e) {
      log.error('trace-ingest.failed', { runId: parsed.data.runId, error: String(e) });
      res.status(500).json({ success: false, message: 'Could not persist trace' });
    }
  });

  return router;
}
