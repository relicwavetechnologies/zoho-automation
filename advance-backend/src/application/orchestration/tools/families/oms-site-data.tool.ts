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
import { CompanyOmsSiteDataService } from '../../../oms/company-oms-site-data.service';
import { OmsSiteDataServiceError, OmsSiteDataToolArgsSchema, type OmsSiteDataToolArgs } from '../../../oms/oms-site-data.types';

const MAX_MODEL_ROWS = 50;

const ResultSchema = z.object({
  status: z.enum(['complete', 'empty', 'partial', 'blocked']),
  operation: z.string(),
  retrievedAt: z.string(),
  coverage: z.record(z.unknown()),
  rows: z.array(z.record(z.unknown())).max(MAX_MODEL_ROWS),
  artifact: z.object({ id: z.string(), downloadUrl: z.string().url(), expiresAt: z.string() }).optional(),
  message: z.string(),
});

type Res = z.infer<typeof ResultSchema>;

export const createOmsSiteDataTool = (deps: {
  service: CompanyOmsSiteDataService;
  cloudinary: CloudinaryAdapter;
  audit?: AuditService;
  csvLinkTtl?: number;
}): Tool<OmsSiteDataToolArgs, Res> => ({
  id: asToolId('omsSiteData'),
  family: 'oms',
  actionGroups: new Set(['read']),
  argsSchema: OmsSiteDataToolArgsSchema,
  resultSchema: ResultSchema,
  description: 'Search the company-approved OMS website inventory through a governed, read-only backend capability.',
  parameterDocs: [
    'operation: search_sites, get_site_profiles, or list_catalog_values.',
    'search_sites: use one or more vetted website, niche, classification, price, quality, traffic, or authority criteria; returns the standard inventory view.',
    'get_site_profiles: look up 1–20 exact bare website hostnames and return the standard full profile view.',
    'list_catalog_values: list distinct current values for a supported inventory field before narrowing a search.',
    'Divo rejects SQL, webhook URLs, headers, API keys, raw OMS columns, raw filters, sorting expressions, and provider request bodies.',
  ].join('\n'),
  permissionCheck(_args: OmsSiteDataToolArgs, perm: PermissionResult) {
    const allowed = perm.allowedActionsByTool.get(asToolId('omsSiteData'))?.has('read') ?? false;
    return allowed
      ? ok('read' as ToolActionGroup)
      : err(new PermissionError({ toolId: 'omsSiteData', action: 'read', reason: 'not_allowed' }));
  },
  async preflight(args: OmsSiteDataToolArgs, ctx: ToolExecutionContext): Promise<Result<Record<string, unknown>, ToolError>> {
    try {
      return ok(await deps.service.preflight(ctx.runContext.companyId, args));
    } catch (error) {
      return err(toToolError(error));
    }
  },
  async execute(args: OmsSiteDataToolArgs, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const startedAt = Date.now();
    try {
      ctx.onProgress?.('Retrieving governed OMS site inventory…');
      const data = await deps.service.execute({ companyId: ctx.runContext.companyId, args });
      const rows = data.rows.slice(0, MAX_MODEL_ROWS);
      let artifact: Res['artifact'];
      if (data.rows.length > MAX_MODEL_ROWS && deps.cloudinary.isAvailable) {
        const headers = headersFor(data.rows);
        const exported = await deps.cloudinary.uploadCsvBuffer({
          buffer: arrayToCsv(headers, data.rows),
          fileName: `oms-site-data-${args.operation}-${new Date().toISOString().slice(0, 10)}.csv`,
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
        ...(artifact ? { artifact } : {}),
        message: messageFor(data.status, data.rows.length, rows.length, Boolean(artifact)),
      };
      deps.audit?.record({
        actorId: ctx.runContext.userId,
        companyId: ctx.runContext.companyId,
        action: 'oms.site_data.query',
        outcome: 'success',
        metadata: {
          operation: args.operation,
          status: result.status,
          rowCount: data.rows.length,
          returnedRowCount: rows.length,
          artifactId: artifact?.id ?? null,
          latencyMs: Date.now() - startedAt,
          correlationId: ctx.correlationId,
        },
      });
      return ok(result);
    } catch (error) {
      const normalized = error instanceof OmsSiteDataServiceError
        ? error
        : new OmsSiteDataServiceError('provider_failure', 'OMS Site Data request failed.');
      deps.audit?.record({
        actorId: ctx.runContext.userId,
        companyId: ctx.runContext.companyId,
        action: 'oms.site_data.query',
        outcome: 'failure',
        metadata: { operation: args.operation, failureCode: normalized.code, latencyMs: Date.now() - startedAt, correlationId: ctx.correlationId },
      });
      if (['not_configured', 'disabled', 'ambiguous_empty_response'].includes(normalized.code)) {
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
  return [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 25);
}

function messageFor(status: 'complete' | 'empty' | 'partial', rowCount: number, returnedRows: number, artifact: boolean): string {
  if (status === 'empty') return 'OMS returned a valid empty JSON array; no matching sites were found.';
  const parts = [`Retrieved ${rowCount} site row${rowCount === 1 ? '' : 's'}.`];
  if (status === 'partial') parts.push('OMS caps responses at 100 rows, so the result may be truncated.');
  if (rowCount > returnedRows) parts.push(`Showing the first ${returnedRows} rows in chat.`);
  if (artifact) parts.push('The complete normalized result is available as a temporary CSV download.');
  return parts.join(' ');
}

function toToolError(error: unknown): ToolError {
  if (error instanceof OmsSiteDataServiceError) {
    const reason = error.code === 'timeout' ? 'timeout'
      : error.code === 'not_configured' || error.code === 'disabled' || error.code === 'ambiguous_empty_response' ? 'bad_args'
        : 'upstream_failure';
    return new ToolError({ toolId: 'omsSiteData', reason, message: error.message, cause: error });
  }
  return new ToolError({ toolId: 'omsSiteData', reason: 'upstream_failure', message: error instanceof Error ? error.message : 'OMS Site Data request failed.', cause: error });
}
