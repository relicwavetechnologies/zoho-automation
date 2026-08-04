import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import type { AuditService } from '../../observability/audit.service';
import { SemrushService } from '../../semrush/semrush.service';
import { SemrushServiceError, SemrushToolArgsSchema, type SemrushFetchedData, type SemrushToolArgs } from '../../semrush/semrush.types';
import type { ApiKeyExhaustionNotifierPort } from '../../governance/api-key-exhaustion.notifier';
import type { DataExportOrchestrationService } from '../../data-export/data-export-orchestration.service';
import type { DataExportOfferPayload } from '../../data-export/export-offer';
import { createDatasetPreview, DATASET_PREVIEW_ROW_LIMIT, type DatasetCoverage } from '../../data-export/dataset-preview';
import {
  exportCandidateMetadata,
  publishExportCandidate,
} from '../../data-export/tool-export-candidate';
import { dataExportRunRequestId } from '../../data-export/export-request-identity';

const MAX_TASK_ROWS = 1_000;

const ResultSchema = z.object({
  status: z.enum(['complete', 'empty', 'partial', 'blocked']),
  operation: z.string(),
  retrievedAt: z.string(),
  coverage: z.record(z.unknown()),
  preview: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())).max(DATASET_PREVIEW_ROW_LIMIT),
    coverage: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('complete'), totalRows: z.number().int().nonnegative() }),
      z.object({
        kind: z.literal('truncated'),
        returnedRows: z.number().int().nonnegative(),
        knownTotal: z.number().int().nonnegative().optional(),
        reason: z.string(),
      }),
      z.object({
        kind: z.literal('provider_limited'),
        returnedRows: z.number().int().nonnegative(),
        reason: z.string(),
      }),
      z.object({ kind: z.literal('unknown'), returnedRows: z.number().int().nonnegative() }),
    ]),
  }).optional(),
  exportCandidate: z.object({
    candidateId: z.string().uuid(),
    sourceKind: z.literal('semrush_snapshot'),
    previewRowCount: z.number().int().nonnegative(),
    estimatedRows: z.number().int().nonnegative().optional(),
    expiresAt: z.string(),
  }).strict().optional(),
  nextPage: z.string().optional(),
  message: z.string(),
});

type Res = z.infer<typeof ResultSchema>;

export const createSemrushTool = (deps: {
  service: SemrushService;
  exportCandidates?: Pick<DataExportOrchestrationService, 'publishCandidate'>;
  audit?: AuditService;
  apiKeyExhaustion?: ApiKeyExhaustionNotifierPort;
}): Tool<SemrushToolArgs, Res> => ({
  id: asToolId('semrush'),
  family: 'semrush',
  actionGroups: new Set(['read']),
  argsSchema: SemrushToolArgsSchema,
  resultSchema: ResultSchema,
  description: 'Run read-only Semrush SEO research through official backend-configured APIs. Supports only explicit operations.',
  parameterDocs: [
    'operation: domain_overview, organic_positions, organic_position_trend, keyword_research, domain_comparison, keyword_gap, or backlinks_comparison.',
    'domain_overview: { domain, database? }. One-row snapshot of rank, organic/paid keywords, traffic and cost.',
    'organic_positions: { domain, database?, limit?, offset? }. limit is 1–1000; Divo returns at most 25 preview rows in chat and can offer a governed export.',
    'organic_position_trend: { domain, database?, limit? }. Monthly history, newest month first; limit is months (default 24). Use it for "is this domain growing", never for current position.',
    'keyword_research: { keywords[1–25], database? }. Volume, CPC, competition and 12-month trend per keyword, batched into one request. Semrush omits keywords it has no data for, so compare coverage.requestedKeywords with returnedKeywords before saying a keyword has no volume.',
    'domain_comparison: { targets[2–5], database?, limit? }. Keywords the targets have in common, with each domain position in its own column.',
    'keyword_gap: { targets[2–5], database?, limit? }. THE FIRST TARGET IS THE ONE YOU OWN and is excluded; the result is what the remaining competitors rank for and it does not. Order matters — reversing it answers the opposite question.',
    'backlinks_comparison: { targets[2–10] }. Authority score, total backlinks and referring domains per target. Costs one billed request per target. If Semrush has no report for a requested target, coverage.missingTargets and the export name it as no provider data rather than zero.',
    'Divo rejects arbitrary Semrush endpoints, headers, cookies, export columns, and API keys. Do not claim an unavailable operation has run.',
  ].join('\n'),
  permissionCheck(_args: SemrushToolArgs, perm: PermissionResult) {
    const allowed = perm.allowedActionsByTool.get(asToolId('semrush'))?.has('read') ?? false;
    return allowed
      ? ok('read' as ToolActionGroup)
      : err(new PermissionError({ toolId: 'semrush', action: 'read', reason: 'not_allowed' }));
  },
  async preflight(args: SemrushToolArgs, ctx: ToolExecutionContext): Promise<Result<Record<string, unknown>, ToolError>> {
    try {
      return ok(await deps.service.preflight(args));
    } catch (error) {
      return err(toToolError(error));
    }
  },
  async execute(args: SemrushToolArgs, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const startedAt = Date.now();
    try {
      ctx.onProgress?.('Retrieving Semrush data…');
      const data = await deps.service.execute(args);
      const allRows = data.rows.slice(0, MAX_TASK_ROWS);
      const candidate = await publishExportCandidate({
        candidates: deps.exportCandidates,
        eligible: allRows.length > 0
          && ctx.runContext.channel === 'lark'
          && Boolean(ctx.runContext.chatId)
          && ctx.perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create') === true,
        payload: () => exportPayloadFor(args, ctx),
        metadata: exportCandidateMetadata({
          columns: allRows.length > 0 ? Object.keys(allRows[0]!) : [],
          previewRowCount: allRows.length,
          estimatedRows: data.status === 'complete' || data.status === 'empty' ? allRows.length : undefined,
          coverage: data.coverage,
        }),
        logger: ctx.logger,
        scope: 'semrush',
        correlationId: ctx.correlationId,
      });
      const preview = createDatasetPreview({
        rows: allRows,
        coverage: previewCoverageFor(data, allRows.length),
      });
      const result: Res = {
        status: data.status,
        operation: data.operation,
        retrievedAt: new Date().toISOString(),
        coverage: data.coverage,
        preview,
        ...(candidate.kind === 'published'
          ? {
              exportCandidate: {
                candidateId: candidate.candidateId,
                sourceKind: 'semrush_snapshot' as const,
                previewRowCount: allRows.length,
                ...(candidate.estimatedRows === undefined ? {} : { estimatedRows: candidate.estimatedRows }),
                expiresAt: candidate.expiresAt.toISOString(),
              },
            }
          : {}),
        ...(data.nextPage ? { nextPage: data.nextPage } : {}),
        message: messageFor({
          rowCount: allRows.length,
          returnedRows: preview.rows.length,
          hasCandidate: candidate.kind === 'published',
          status: data.status,
          missingTargets: stringValues(data.coverage.missingTargets),
        }),
      };
      deps.audit?.record({
        actorId: ctx.runContext.userId,
        companyId: ctx.runContext.companyId,
        action: 'semrush.query',
        outcome: 'success',
        metadata: {
          operation: args.operation,
          status: result.status,
          rowCount: allRows.length,
          returnedRowCount: preview.rows.length,
          exportCandidateId: candidate.kind === 'published' ? candidate.candidateId : null,
          latencyMs: Date.now() - startedAt,
          correlationId: ctx.correlationId,
        },
      });
      void deps.apiKeyExhaustion?.clear(ctx.runContext.companyId, 'semrush');
      return ok(result);
    } catch (error) {
      const normalized = error instanceof SemrushServiceError ? error : new SemrushServiceError('provider_failure', 'Semrush request failed.');
      deps.audit?.record({
        actorId: ctx.runContext.userId,
        companyId: ctx.runContext.companyId,
        action: 'semrush.query',
        outcome: 'failure',
        metadata: { operation: args.operation, failureCode: normalized.code, latencyMs: Date.now() - startedAt, correlationId: ctx.correlationId },
      });
      if (normalized.code === 'provider_insufficient_units') {
        void deps.apiKeyExhaustion?.notifyIfExhausted({
          companyId: ctx.runContext.companyId,
          provider: 'semrush',
          code: normalized.code,
          message: normalized.message,
          source: 'semrush.tool',
        });
      }
      if (['not_configured', 'capability_unavailable'].includes(normalized.code)) {
        return ok({
          status: 'blocked',
          operation: args.operation,
          retrievedAt: new Date().toISOString(),
          coverage: {},
          message: normalized.message,
        });
      }
      return err(toToolError(normalized));
    }
  },
});

function messageFor(input: {
  rowCount: number;
  returnedRows: number;
  hasCandidate: boolean;
  status: Res['status'];
  missingTargets: readonly string[];
}): string {
  if (input.status === 'empty') return 'Semrush returned no matching data for this request.';
  const parts = [`Retrieved ${input.rowCount} row${input.rowCount === 1 ? '' : 's'}.`];
  if (input.rowCount > input.returnedRows) parts.push(`Showing the first ${input.returnedRows} rows in chat.`);
  if (input.hasCandidate) parts.push('If the member asks for Sheet, Excel, or CSV, use the returned export candidate; Divo reruns current provider data for the file.');
  if (input.missingTargets.length > 0) parts.push(`Semrush returned no backlink overview for: ${input.missingTargets.join(', ')}.`);
  return parts.join(' ');
}

function stringValues(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function previewCoverageFor(data: SemrushFetchedData, rowCount: number): DatasetCoverage {
  if (data.status === 'complete' || data.status === 'empty') {
    return { kind: 'complete', totalRows: rowCount };
  }
  return data.nextPage
    ? { kind: 'truncated', returnedRows: rowCount, reason: 'semrush_next_page_available' }
    : { kind: 'provider_limited', returnedRows: rowCount, reason: 'semrush_requested_limit_without_pagination_or_total' };
}

function exportPayloadFor(
  args: SemrushToolArgs,
  ctx: ToolExecutionContext,
): DataExportOfferPayload {
  return {
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
    ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args,
    },
    destination: {
      format: 'auto',
      title: semrushExportTitle(args),
    },
    chatId: ctx.runContext.chatId!,
    ...(ctx.runContext.runtimeThreadId
      ? { conversationKey: ctx.runContext.runtimeThreadId }
      : {}),
    ...(ctx.runContext.replyToMessageId ? { replyToMessageId: ctx.runContext.replyToMessageId } : {}),
    ...(ctx.runContext.replyInThread !== undefined ? { replyInThread: ctx.runContext.replyInThread } : {}),
    requestId: dataExportRunRequestId(ctx.runContext, ctx.correlationId),
    ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
  };
}

function semrushExportTitle(args: SemrushToolArgs): string {
  const subject = 'domain' in args
    ? args.domain
    : 'targets' in args
      ? args.targets.join(', ')
      : args.operation === 'keyword_research'
        ? `${args.keywords.length} keywords`
        : 'report';
  return `Semrush ${args.operation.replaceAll('_', ' ')} — ${subject}`;
}

function toToolError(error: unknown): ToolError {
  if (error instanceof SemrushServiceError) {
    const reason = error.code === 'timeout' ? 'timeout'
      : error.code === 'capability_unavailable' || error.code === 'not_configured' ? 'bad_args'
        : error.code === 'rate_limited' ? 'retryable'
          : 'upstream_failure';
    return new ToolError({ toolId: 'semrush', reason, message: error.message, cause: error });
  }
  return new ToolError({ toolId: 'semrush', reason: 'upstream_failure', message: error instanceof Error ? error.message : 'Semrush request failed.', cause: error });
}
