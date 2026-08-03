import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import type { AuditService } from '../../observability/audit.service';
import { contributeExportPart } from '../../data-export/tool-export-offer';
import { dataExportRunRequestId } from '../../data-export/export-request-identity';
import type { DataExportOfferService } from '../../data-export/data-export-offer.service';
import type { DataExportOfferPayload } from '../../data-export/export-offer';
import {
  MenhoodQueryRequestSchema,
  MenhoodQueryResultSchema,
  MenhoodQueryValidationError,
  type MenhoodQueryRequest,
  type ValidatedMenhoodQuery,
  validateMenhoodQuery,
} from '../../menhood/menhood-query';
import {
  MenhoodQueryService,
  MenhoodQueryServiceError,
} from '../../menhood/menhood-query.service';

type MenhoodService = Pick<MenhoodQueryService, 'preflight' | 'execute'>;

const ResultSchema = z.object({
  status: z.enum(['complete', 'partial']),
  queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  elapsedMs: z.number().nonnegative(),
  preview: z.object({
    columns: z.array(z.string()),
    rows: MenhoodQueryResultSchema.shape.rows,
    coverage: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('complete'), totalRows: z.number().int().nonnegative() }),
      z.object({
        kind: z.literal('truncated'),
        returnedRows: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ]),
    exportOfferId: z.string().optional(),
    exportRowCount: z.number().int().nonnegative().optional(),
    exportWithdrawn: z.literal(true).optional(),
  }),
  message: z.string(),
});

type MenhoodDataToolResult = z.infer<typeof ResultSchema>;

export const createMenhoodDataTool = (deps: {
  service: MenhoodService;
  offers?: Pick<DataExportOfferService, 'appendAuthorizedPart'>;
  audit?: AuditService;
}): Tool<MenhoodQueryRequest, MenhoodDataToolResult> => ({
  id: asToolId('menhoodData'),
  family: 'menhood',
  actionGroups: new Set(['read']),
  argsSchema: MenhoodQueryRequestSchema,
  resultSchema: ResultSchema,
  description: 'Query the company Menhood Airtable sync with a governed, read-only PostgreSQL SELECT.',
  parameterDocs: [
    'sql: exactly one SELECT or read-only WITH query over menhood_orders, menhood_customers, menhood_products, or all_cities_with_pincode.',
    'parameters: positional JSON-safe values matching $1, $2, and so on; never interpolate user text into SQL.',
    'exportTitle: optional short title for a later governed export.',
    'menhood_advertisement_costs is intentionally unavailable.',
  ].join('\n'),
  permissionCheck(_args, perm: PermissionResult) {
    const allowed = perm.allowedActionsByTool.get(asToolId('menhoodData'))?.has('read') ?? false;
    return allowed
      ? ok('read' as ToolActionGroup)
      : err(new PermissionError({ toolId: 'menhoodData', action: 'read', reason: 'not_allowed' }));
  },
  async preflight(args, ctx): Promise<Result<Record<string, unknown>, ToolError>> {
    try {
      deps.service.preflight(ctx.runContext.companyId);
      const validated = validateMenhoodQuery(args);
      return ok({ ready: true, tables: validated.tables, queryFingerprint: validated.fingerprint });
    } catch (error) {
      return err(toToolError(error));
    }
  },
  async execute(args: MenhoodQueryRequest, ctx: ToolExecutionContext): Promise<Result<MenhoodDataToolResult, ToolError>> {
    const startedAt = Date.now();
    let validated: ValidatedMenhoodQuery | undefined;
    try {
      ctx.abortSignal?.throwIfAborted();
      validated = validateMenhoodQuery(args);
      // Captured so the offer closure sees the narrowed value, not the
      // still-possibly-undefined outer binding used by the catch block.
      const validatedQuery = validated;
      const data = await deps.service.execute(ctx.runContext.companyId, args);
      const offer = await contributeExportPart({
        offers: deps.offers,
        eligible: data.rows.length > 0
          && ctx.runContext.channel === 'lark'
          && Boolean(ctx.runContext.chatId)
          && ctx.perm.allowedActionsByTool.get(asToolId('dataExport'))?.has('create') === true,
        payload: () => exportPayloadFor(validatedQuery, ctx),
        observedRowCount: data.rows.length,
        collectionTitle: 'Menhood query results',
        logger: ctx.logger,
        scope: 'menhood',
        correlationId: ctx.correlationId,
      });
      const result: MenhoodDataToolResult = {
        status: data.coverage.truncated ? 'partial' : 'complete',
        queryFingerprint: data.queryFingerprint,
        elapsedMs: data.elapsedMs,
        preview: {
          columns: data.columns.map(column => column.name),
          rows: data.rows,
          coverage: data.coverage.truncated
            ? { kind: 'truncated', returnedRows: data.coverage.returnedRows, reason: 'menhood_more_rows_available' }
            : { kind: 'complete', totalRows: data.coverage.returnedRows },
          ...(offer.kind === 'offered' ? { exportOfferId: offer.offerId, exportRowCount: offer.observedRowCount } : {}),
          ...(offer.kind === 'withdrawn' ? { exportWithdrawn: true as const } : {}),
        },
        message: data.coverage.truncated
          ? `Showing the first ${data.coverage.returnedRows} matching rows.${offer.kind === 'offered' ? ' A governed export is available and reruns this query when confirmed.' : ''}`
          : `Retrieved ${data.coverage.returnedRows} matching row${data.coverage.returnedRows === 1 ? '' : 's'}.${offer.kind === 'offered' ? ' A governed export is available and reruns this query when confirmed.' : ''}`,
      };
      deps.audit?.record({
        actorId: ctx.runContext.userId,
        companyId: ctx.runContext.companyId,
        action: 'menhood.data.query',
        outcome: 'success',
        metadata: {
          queryFingerprint: validated.fingerprint,
          tables: validated.tables,
          returnedRows: data.coverage.returnedRows,
          truncated: data.coverage.truncated,
          exportOfferId: offer.kind === 'offered' ? offer.offerId : null,
          latencyMs: Date.now() - startedAt,
          correlationId: ctx.correlationId,
        },
      });
      return ok(result);
    } catch (error) {
      const normalized = toToolError(error);
      deps.audit?.record({
        actorId: ctx.runContext.userId,
        companyId: ctx.runContext.companyId,
        action: 'menhood.data.query',
        outcome: 'failure',
        metadata: {
          ...(validated ? {
            queryFingerprint: validated.fingerprint,
            tables: validated.tables,
            returnedRows: 0,
          } : {}),
          failureReason: normalized.payload.reason,
          latencyMs: Date.now() - startedAt,
          correlationId: ctx.correlationId,
        },
      });
      return err(normalized);
    }
  },
});

function exportPayloadFor(
  query: ValidatedMenhoodQuery,
  ctx: ToolExecutionContext,
): DataExportOfferPayload {
  return {
    companyId: ctx.runContext.companyId,
    userId: ctx.runContext.userId,
    ...(ctx.runContext.departmentId ? { departmentId: ctx.runContext.departmentId } : {}),
    source: {
      kind: 'menhood_query',
      connectionId: 'backend_managed',
      query: {
        sql: query.normalizedSql,
        parameters: query.parameters,
        ...(query.exportTitle ? { exportTitle: query.exportTitle } : {}),
      },
      queryFingerprint: query.fingerprint,
    },
    destination: {
      format: 'auto',
      title: query.exportTitle ?? 'Menhood data export',
    },
    chatId: ctx.runContext.chatId!,
    ...(ctx.runContext.runtimeThreadId ? { conversationKey: ctx.runContext.runtimeThreadId } : {}),
    ...(ctx.runContext.replyToMessageId ? { replyToMessageId: ctx.runContext.replyToMessageId } : {}),
    ...(ctx.runContext.replyInThread !== undefined ? { replyInThread: ctx.runContext.replyInThread } : {}),
    requestId: dataExportRunRequestId(ctx.runContext, ctx.correlationId),
    ...(ctx.runContext.traceId ? { traceId: ctx.runContext.traceId } : {}),
  };
}

function toToolError(error: unknown): ToolError {
  if (error instanceof MenhoodQueryValidationError) {
    return new ToolError({ toolId: 'menhoodData', reason: 'bad_args', message: error.message, cause: error });
  }
  if (error instanceof MenhoodQueryServiceError) {
    const reason = error.code === 'timeout' ? 'timeout' : 'upstream_failure';
    return new ToolError({ toolId: 'menhoodData', reason, message: error.message, cause: error });
  }
  return new ToolError({
    toolId: 'menhoodData',
    reason: 'upstream_failure',
    message: 'Menhood query failed',
    cause: error,
  });
}
