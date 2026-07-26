import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { CloudinaryAdapter } from '../../../../infrastructure/cloudinary/cloudinary.adapter';
import type { AuditService } from '../../../observability/audit.service';
import { arrayToCsv } from '../shared/sandbox-runner';
import { SemrushService } from '../../../semrush/semrush.service';
import { SemrushServiceError, SemrushToolArgsSchema, type SemrushToolArgs } from '../../../semrush/semrush.types';
import type { ApiKeyExhaustionNotifierPort } from '../../../governance/api-key-exhaustion.notifier';

const MAX_MODEL_ROWS = 200;
const MAX_TASK_ROWS = 1_000;

const ResultSchema = z.object({
  status: z.enum(['complete', 'empty', 'partial', 'blocked']),
  operation: z.string(),
  retrievedAt: z.string(),
  coverage: z.record(z.unknown()),
  rows: z.array(z.record(z.unknown())).max(MAX_MODEL_ROWS),
  nextPage: z.string().optional(),
  artifact: z.object({ id: z.string(), downloadUrl: z.string().url(), expiresAt: z.string() }).optional(),
  message: z.string(),
});

type Res = z.infer<typeof ResultSchema>;

export const createSemrushTool = (deps: {
  service: SemrushService;
  cloudinary: CloudinaryAdapter;
  audit?: AuditService;
  csvLinkTtl?: number;
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
    'organic_positions: { domain, database?, limit?, offset? }. limit is 1–1000; Divo returns at most 200 rows in chat and creates a temporary CSV for larger results.',
    'organic_position_trend: { domain, database?, limit? }. Monthly history, newest month first; limit is months (default 24). Use it for "is this domain growing", never for current position.',
    'keyword_research: { keywords[1–25], database? }. Volume, CPC, competition and 12-month trend per keyword, batched into one request. Semrush omits keywords it has no data for, so compare coverage.requestedKeywords with returnedKeywords before saying a keyword has no volume.',
    'domain_comparison: { targets[2–5], database?, limit? }. Keywords the targets have in common, with each domain position in its own column.',
    'keyword_gap: { targets[2–5], database?, limit? }. THE FIRST TARGET IS THE ONE YOU OWN and is excluded; the result is what the remaining competitors rank for and it does not. Order matters — reversing it answers the opposite question.',
    'backlinks_comparison: { targets[2–10] }. Authority score, total backlinks and referring domains per target. Costs one billed request per target, so ask for the domains that matter rather than a wide sweep.',
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
      const rows = allRows.slice(0, MAX_MODEL_ROWS);
      let artifact: Res['artifact'];
      if (allRows.length > MAX_MODEL_ROWS && deps.cloudinary.isAvailable) {
        const headers = headersFor(allRows);
        const exported = await deps.cloudinary.uploadCsvBuffer({
          buffer: arrayToCsv(headers, allRows),
          fileName: `semrush-${args.operation}-${new Date().toISOString().slice(0, 10)}.csv`,
          companyId: ctx.runContext.companyId,
          ttlSeconds: deps.csvLinkTtl ?? 86_400,
        });
        if (exported) artifact = { id: exported.publicId, downloadUrl: exported.signedUrl, expiresAt: exported.expiresAt };
      }
      const result: Res = {
        status: data.status,
        operation: data.operation,
        retrievedAt: new Date().toISOString(),
        coverage: data.coverage,
        rows,
        ...(data.nextPage ? { nextPage: data.nextPage } : {}),
        ...(artifact ? { artifact } : {}),
        message: messageFor({ rowCount: allRows.length, returnedRows: rows.length, artifact: Boolean(artifact), status: data.status }),
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
          returnedRowCount: rows.length,
          artifactId: artifact?.id ?? null,
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
          rows: [],
          message: normalized.message,
        });
      }
      return err(toToolError(normalized));
    }
  },
});

function headersFor(rows: Array<Record<string, unknown>>): string[] {
  return [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 60);
}

function messageFor(input: { rowCount: number; returnedRows: number; artifact: boolean; status: Res['status'] }): string {
  if (input.status === 'empty') return 'Semrush returned no matching data for this request.';
  const parts = [`Retrieved ${input.rowCount} row${input.rowCount === 1 ? '' : 's'}.`];
  if (input.rowCount > input.returnedRows) parts.push(`Showing the first ${input.returnedRows} rows in chat.`);
  if (input.artifact) parts.push('The complete normalized result is available as a temporary CSV download.');
  return parts.join(' ');
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
