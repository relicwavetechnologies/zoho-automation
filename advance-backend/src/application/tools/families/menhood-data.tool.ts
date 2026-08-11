import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import type { AuditService } from '../../observability/audit.service';
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

type MenhoodService = Pick<MenhoodQueryService, 'preflight' | 'execute' | 'coverageWindow'>;

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
  }),
  // Attached to every result, not only suspicious ones. The caller has no other
  // way to tell a settled count from one that is still filling in, and the
  // failure this prevents is a plausible number reported as complete.
  freshness: z.object({
    ordersThrough: z.string().nullable(),
    maturedThrough: z.string(),
    maturityDays: z.number().int().positive(),
    maturityCurve: z.array(z.object({
      days: z.number().int().positive(),
      arrivedPct: z.string(),
    }).strict()).readonly(),
    containsNoSpendOrCostData: z.literal(true),
  }).strict(),
  // A LIMIT the caller wrote itself. The rows it returns are indistinguishable
  // from a complete breakdown, so the truncation has to be named in the result.
  queryLimit: z.object({
    rows: z.number().int().positive(),
    note: z.string(),
  }).strict().optional(),
  message: z.string(),
});

type MenhoodDataToolResult = z.infer<typeof ResultSchema>;

export const createMenhoodDataTool = (deps: {
  service: MenhoodService;
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
    'For row-level previews, include a deterministic ORDER BY on stable columns, e.g. order lines by order_date, order_number, id.',
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
      const validatedQuery = validated;
      const [data, freshness] = await Promise.all([
        deps.service.execute(ctx.runContext.companyId, args),
        deps.service.coverageWindow(ctx.runContext.companyId),
      ]);
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
        },
        freshness,
        ...(validatedQuery.topLevelLimit === undefined
          ? {}
          : {
              queryLimit: {
                rows: validatedQuery.topLevelLimit,
                note: `Your query ends in LIMIT ${validatedQuery.topLevelLimit}. These are the top ${validatedQuery.topLevelLimit} rows of an unknown total, not the full set.`
                  + ' Present them as a top-N selection, never as a complete breakdown or distribution, and never compute a share, percentage of total, or "the rest" from them.'
                  + ' To describe a full breakdown, rerun without the LIMIT or aggregate the tail into an explicit Other bucket.',
              },
            }),
        message: [
          data.coverage.truncated
            ? `Showing the first ${data.coverage.returnedRows} matching rows.`
            : `Retrieved ${data.coverage.returnedRows} matching row${data.coverage.returnedRows === 1 ? '' : 's'}.`,
          freshnessNote(freshness, data.coverage.returnedRows),
        ].join(' '),
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

/**
 * An empty Menhood result is almost never "it did not happen". Orders arrive
 * here for weeks after they are placed, so a recent window is out of range or
 * undercounted, and both look identical to a caller reading only the row count.
 * Saying so in the message is what stops zero rows being reported as zero
 * orders, and a still-filling count being reported as a settled one.
 */
function freshnessNote(
  freshness: { ordersThrough: string | null; maturedThrough: string; maturityDays: number },
  returnedRows: number,
): string {
  if (!freshness.ordersThrough) {
    return 'Coverage window unavailable for this run; do not describe any count here as complete.';
  }
  const settled =
    `Orders exist only through ${freshness.ordersThrough}, and order dates after ${freshness.maturedThrough} are still arriving`
    + ` — they undercount until roughly ${freshness.maturityDays} days have passed.`
    + ` SOURCE FINALITY RULE: if the requested end date is later than ${freshness.maturedThrough}, do not present this number as final; use live Airtable.`;
  return returnedRows === 0
    ? `${settled} No rows here means the window is out of range or not yet populated, never that no orders were placed.`
    : settled;
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
