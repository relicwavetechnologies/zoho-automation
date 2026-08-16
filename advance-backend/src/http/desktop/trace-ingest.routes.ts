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
import { sanitizeLatencyAttributes } from '../../application/observability/run-latency-recorder';
import { ExecutionRepository } from '../../infrastructure/persistence/execution.repository';
import { TokenUsageService } from '../../application/observability/token-usage.service';
import { PersonaLearningService } from '../../application/persona-learning/persona-learning.service';
import type { PersonaLearningToolSummary } from '../../application/persona-learning/persona-learning.types';
import type { KnowledgeLearningService } from '../../application/knowledge/knowledge-learning.service';
import { isProtectedShopifyToolId } from '../../application/shopify/shopify-protected-result';
import { RUNTIME_CHANNELS, type RuntimeChannel } from '../../domain/channel/runtime-channel';
import { canonicalToolIdForToolName } from '../../domain/tools/tool-id';

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
const spanAttributeValue = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
const spanAttributesSchema = z.record(z.string().max(80), spanAttributeValue)
  .refine(value => Object.keys(value).length <= 20, 'Span attributes are limited to 20 keys')
  .transform(value => sanitizeLatencyAttributes(value));
const MAX_SPAN_MS = 24 * 60 * 60 * 1_000;
const sourceTimeSchema = z.number().finite().nonnegative().optional();

const eventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind:      z.literal('tool'),
    seq:       z.number().int().nonnegative(),
    ts:        sourceTimeSchema,
    toolName:  z.string().min(1).max(200),
    input:     jsonValue.optional(),
    output:    jsonValue.optional(),
    isError:   z.boolean().optional(),
    summary:   z.string().max(2000).optional(),
  }),
  z.object({
    kind:        z.literal('model'),
    seq:         z.number().int().nonnegative(),
    ts:          sourceTimeSchema,
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
    ts:      sourceTimeSchema,
    title:   z.string().max(300).optional(),
    summary: z.string().max(2000).optional(),
    status:  z.enum(['ok', 'error']).optional(),
  }),
  z.object({
    kind: z.literal('learning_context'),
    seq: z.number().int().nonnegative(),
    ts: sourceTimeSchema,
    userMessages: z.array(z.string().max(4_000)).max(12),
    assistantResponse: z.string().max(6_000).optional(),
    toolSummary: z.array(z.object({
      toolName: z.string().min(1).max(200),
      isError: z.boolean(),
      summary: z.string().max(500).optional(),
    }).strict()).max(20),
  }),
  z.object({
    kind:         z.literal('span'),
    seq:          z.number().int().nonnegative(),
    ts:           z.number().finite().nonnegative(),
    spanId:       z.string().min(1).max(300),
    parentSpanId: z.string().min(1).max(300).optional(),
    name:         z.string().min(1).max(200),
    category:     z.enum([
      'runtime', 'provider', 'gateway', 'authorization',
      'persistence', 'cache', 'tool', 'delivery',
    ]),
    source:       z.string().min(1).max(100),
    startedAt:    z.number().finite().nonnegative(),
    endedAt:      z.number().finite().nonnegative(),
    durationMs:   z.number().finite().nonnegative().max(MAX_SPAN_MS),
    status:       z.enum(['ok', 'error']),
    attributes:   spanAttributesSchema.optional(),
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
}).superRefine((batch, ctx) => {
  batch.events.forEach((event, index) => {
    if (event.kind !== 'span') return;
    if (event.endedAt < event.startedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events', index, 'endedAt'],
        message: 'Span endedAt precedes startedAt',
      });
    }
    if (Math.abs((event.endedAt - event.startedAt) - event.durationMs) > 2_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events', index, 'durationMs'],
        message: 'Span duration does not match its timestamps',
      });
    }
  });
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

const RECALLED_KNOWLEDGE_BLOCK = /<recalled_knowledge\b[^>]*>[\s\S]*?<\/recalled_knowledge>/gi;
const INTERNAL_CONTEXT_SUMMARY = /\b(Backend-recalled (reference|personal) facts|RETRIEVAL_STATUS:|RETRIEVAL_COVERAGE:|CONFLICT_PRECEDENCE:)\b/i;
const XMLISH_TAG = /<\/?[a-z][a-z0-9_-]*(\s[^>]*)?>/i;
const ATTACHED_FILES = /\[ATTACHED_FILES\]\s*\[[\s\S]*?\]\s*/i;
const QUOTED_FILE_NAME = /"name"\s*:\s*"([^"]+)"/i;
const PATH_FILE_NAME = /\/([^/"]+\.[a-z0-9]{2,6})(?=["\s,]|$)/i;
const DOMAIN = /([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/i;
const TITLE_MAX = 96;
const FILE_WORDS = new Set(['api', 'crm', 'csv', 'gst', 'hdfc', 'hsbc', 'id', 'irdai', 'pdf', 'qa', 'seo', 'tds']);

function compactRunTitle(text: string): string | undefined {
  const clean = text.replace(/\s+/g, ' ').replace(/[.?!,:;]+$/g, '').trim();
  if (!clean) return undefined;
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean;
}

function titleCaseFileName(raw: string): string | undefined {
  const decoded = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
  const leaf = decoded.split(/[\\/]/).pop()?.trim();
  if (!leaf) return undefined;
  const extension = leaf.match(/\.([a-z0-9]{2,6})$/i)?.[1]?.toLowerCase();
  const base = leaf
    .replace(/\.[a-z0-9]{2,6}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(divo|test\d*)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return extension ? extension.toUpperCase() : undefined;
  const words = base.split(' ').map((word) => {
    const lower = word.toLowerCase();
    if (FILE_WORDS.has(lower)) return lower.toUpperCase();
    return lower.length <= 2 ? lower : `${lower[0]!.toUpperCase()}${lower.slice(1)}`;
  });
  if (extension) words.push(extension.toUpperCase());
  return compactRunTitle(words.join(' '));
}

function promptTitleFromText(text: string): string | undefined {
  const seoDomain = text.match(/\bdaily\s+SEO\s+competitive\s+report\s+(?:on|for)\s+/i)
    ? text.match(DOMAIN)?.[1]
    : undefined;
  if (seoDomain) return `Daily SEO report for ${seoDomain.toLowerCase()}`;

  const trimmed = text
    .replace(/^Task:\s*/i, '')
    .replace(/^You are running read-only Divo governed research for\s+/i, '')
    .replace(/^a\s+/i, '')
    .replace(/\bExecute exactly\b[\s\S]*$/i, '')
    .replace(/\bUse the\b[\s\S]*$/i, '')
    .trim();
  if (!trimmed || /^[{\[]/.test(trimmed)) return undefined;
  if (/^(asked in lark|something you asked divo)$/i.test(trimmed)) return undefined;
  return compactRunTitle(trimmed);
}

function attachedFileTitle(text: string): string | undefined {
  if (!/\[ATTACHED_FILES\]/i.test(text)) return undefined;
  const afterManifest = text.replace(ATTACHED_FILES, ' ').trim();
  if (afterManifest && !afterManifest.startsWith('{') && !afterManifest.startsWith('[')) {
    const promptTitle = promptTitleFromText(afterManifest);
    if (promptTitle) return promptTitle;
  }
  const named = text.match(QUOTED_FILE_NAME)?.[1];
  const file = named && /\.[a-z0-9]{2,6}$/i.test(named) ? named : text.match(PATH_FILE_NAME)?.[1] ?? named;
  const label = file ? titleCaseFileName(file) : undefined;
  return label ? `Review ${label}` : 'Review attached files';
}

function publicRunSummary(summary: string | undefined, fallback?: string): string | undefined {
  const text = summary
    ?.replace(RECALLED_KNOWLEDGE_BLOCK, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || INTERNAL_CONTEXT_SUMMARY.test(text) || XMLISH_TAG.test(text)) return fallback;
  return attachedFileTitle(text) ?? promptTitleFromText(text) ?? fallback;
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
  if (ev.kind === 'span') {
    await runs.upsertSpan({
      executionId: ctx.executionId,
      spanId: ev.spanId,
      ...(ev.parentSpanId ? { parentSpanId: ev.parentSpanId } : {}),
      name: ev.name,
      category: ev.category,
      source: ev.source,
      startedAt: sourceTimestamp(ev.startedAt),
      endedAt: sourceTimestamp(ev.endedAt),
      durationMs: ev.durationMs,
      status: ev.status,
      ...(ev.attributes ? { attributes: sanitizeLatencyAttributes(ev.attributes) } : {}),
    });
    return;
  }

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
        ...eventSourceTime(ev),
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
        ...eventSourceTime(ev),
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
        ...eventSourceTime(ev),
        payload: {
          userMessageCount: ev.userMessages.length,
          hasAssistantResponse: Boolean(ev.assistantResponse),
          toolCount: ev.toolSummary.length,
        },
      });
      return;
    }

    // Boundary events (run/turn start/end).
    const boundarySummary = protectedRun
      ? ev.kind === 'run_end'
        ? ev.status === 'error'
          ? 'Protected Shopify run failed; details redacted'
          : 'Protected Shopify run completed; details redacted'
        : 'Protected Shopify run summary redacted'
      : publicRunSummary(ev.summary, ev.kind === 'run_end' ? fallbackRunSummary : undefined);

    await runs.appendEvent({
      executionId: ctx.executionId,
      sequence:    ev.seq,
      phase:       ev.kind.startsWith('run') ? 'run' : 'turn',
      eventType:   ev.kind,
      actorType:   'engine',
      title:       ev.title ?? ev.kind,
      ...(boundarySummary ? { summary: boundarySummary } : {}),
      ...(ev.status  ? { status:  ev.status }  : {}),
      ...eventSourceTime(ev),
    });

    if (ev.kind === 'run_end') {
      if (ev.status === 'error') {
        await runs.fail(
          ctx.executionId,
          'pi_run_error',
          protectedRun ? 'Protected Shopify run failed; details redacted' : boundarySummary ?? 'Run failed',
        );
      } else {
        await runs.complete(
          ctx.executionId,
          boundarySummary,
        );
      }
    }
}

function eventSourceTime(event: { readonly ts?: number | undefined }): { sourceTimestamp?: Date } {
  return event.ts === undefined ? {} : { sourceTimestamp: sourceTimestamp(event.ts) };
}

function sourceTimestamp(epochMs: number): Date {
  // Source time is diagnostic, never an authorization input. Keep malformed
  // clocks from creating dates outside a useful operational window.
  const earliest = Date.UTC(2020, 0, 1);
  const latest = Date.now() + 24 * 60 * 60 * 1_000;
  return new Date(Math.min(latest, Math.max(earliest, Math.round(epochMs))));
}

/**
 * Desktop traces are client-authored diagnostics, not an authority for data
 * classification. Recognize only the closed legacy gateway envelope or exact
 * backend-registered typed tool names, then let the backend tool ID decide
 * whether result content must be suppressed.
 */
function protectedShopifyTraceMetadata(
  event: TraceEvent,
): { readonly provider: 'shopify'; readonly toolId: string; readonly operation: string | null; readonly connectionId: string | null } | null {
  if (event.kind !== 'tool') return null;

  if (event.toolName !== 'divo_gateway') {
    const toolId = canonicalToolIdForToolName(event.toolName);
    if (!toolId || !isProtectedShopifyToolId(toolId)) return null;
    const args = asRecord(event.input);
    return {
      provider: 'shopify',
      toolId,
      operation: typeof args?.['operation'] === 'string' ? args['operation'] : null,
      connectionId: typeof args?.['connectionId'] === 'string' ? args['connectionId'] : null,
    };
  }

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
