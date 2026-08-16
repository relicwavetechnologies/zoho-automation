import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import type { AuditService } from '../../observability/audit.service';
import { CompanyOmsSiteDataService } from '../../oms/company-oms-site-data.service';
import { defaultSortDirection, excludesUnmeasuredSpamScore, OmsSiteDataServiceError, OmsSiteDataToolArgsSchema, type OmsSiteDataToolArgs } from '../../oms/oms-site-data.types';
import { createDatasetPreview, DATASET_PREVIEW_ROW_LIMIT } from '../../provider-data/dataset-preview';

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
  message: z.string(),
});

type Res = z.infer<typeof ResultSchema>;

export const createOmsSiteDataTool = (deps: {
  service: CompanyOmsSiteDataService;
  audit?: AuditService;
}): Tool<OmsSiteDataToolArgs, Res> => ({
  id: asToolId('omsSiteData'),
  family: 'oms',
  actionGroups: new Set(['read']),
  argsSchema: OmsSiteDataToolArgsSchema,
  resultSchema: ResultSchema,
  description: 'Sanitize OMS website inputs or search the company-approved OMS website inventory through a governed, read-only backend capability.',
  parameterDocs: [
    'operation: sanitize_website_inputs, search_sites, get_site_profiles, or list_catalog_values.',
    'sanitize_website_inputs: pass pasted emails, http/https URLs, or hostnames in inputs; returns deterministic OMS-ready website hostnames without calling OMS. Credential-bearing URLs and non-web URL schemes are rejected.',
    'search_sites: use one or more vetted website, niche, classification, price, quality, traffic, or authority criteria; returns the standard inventory view.',
    'search_sites quality filters: maxSpamScore (lower is better, use it for clean/safe site requests), minDomainRating, minDomainAuthority, minPageAuthority.',
    'search_sites spam score: OMS stores "never measured" as a negative spam score. Setting maxSpamScore, or ranking cleanest-first, automatically excludes those unmeasured sites, so such a result is the set of sites with a MEASURED spam score, not every matching site. Set minSpamScore yourself to override.',
    'search_sites traffic filters, all min/max: minOrganicTraffic is Semrush ORGANIC traffic, minSemrushTraffic is Semrush TOTAL traffic; minAhrefTraffic and minSimilarwebTraffic are separate vendor estimates. They disagree, so pick the one the user named and never blend them.',
    'search_sites accepts at most 20 criteria per call.',
    'search_sites sortBy: set it whenever the user wants best/top/cheapest sites. OMS sorts before applying its 100-row cap, so sorting changes which rows come back, not just their order.',
    'search_sites sortDirection: defaults to DESC, except spamScore, sellingPrice, costPrice and turnAroundTime, which default to ASC because lower is better for those. Pass it explicitly when the user wants the opposite.',
    'get_site_profiles: pass websites, an array of 1–20 exact bare hostnames; returns the standard full profile view. The field is named websites, not hostnames or domains.',
    'list_catalog_values: pass field, one supported inventory field, to list its distinct current values before narrowing a search.',
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
      const preview = createDatasetPreview({
        rows: data.rows,
        coverage: {
          kind: 'provider_limited',
          returnedRows: data.rows.length,
          reason: data.status === 'partial'
            ? 'oms_100_row_cap_without_pagination_or_total'
            : 'oms_snapshot_without_pagination_or_total',
        },
      });
      const result: Res = {
        status: data.status,
        operation: data.operation,
        retrievedAt: new Date().toISOString(),
        coverage: data.coverage,
        preview,
        message: messageFor(
          data.status,
          data.rows.length,
          preview.rows.length,
          data.coverage,
          args,
        ),
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
          returnedRowCount: preview.rows.length,
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
          message: normalized.message,
        });
      }
      return err(toToolError(normalized));
    }
  },
});

/**
 * The agent reads this after every call, so the 100-row provider cap is stated
 * unconditionally rather than only when it is hit. Without that, a 40-row
 * result reads as "there are 40 such sites" when it only means "40 matched
 * within a capped window".
 *
 * The cap is also not uniformly lossy. OMS applies ORDER BY server-side before
 * truncating (verified against the live endpoint), so a sorted 100-row response
 * is a true top-100 ranking, while an unsorted one is an arbitrary subset.
 * Those two cases warrant different follow-up, so they are described separately.
 */
function messageFor(
  status: 'complete' | 'empty' | 'partial',
  rowCount: number,
  returnedRows: number,
  coverage: Record<string, unknown>,
  args: OmsSiteDataToolArgs,
): string {
  if (args.operation === 'sanitize_website_inputs') {
    const sanitizedRows = typeof coverage.sanitizedRows === 'number' ? coverage.sanitizedRows : 0;
    const invalidRows = typeof coverage.invalidRows === 'number' ? coverage.invalidRows : rowCount - sanitizedRows;
    const parts = [`Sanitized ${sanitizedRows} of ${rowCount} candidate input${rowCount === 1 ? '' : 's'} into OMS-ready website hostnames.`];
    if (invalidRows > 0) parts.push(`${invalidRows} candidate${invalidRows === 1 ? ' was' : 's were'} invalid and kept in the preview with a reason.`);
    parts.push('Use the website column for exact OMS lookups. This operation did not call OMS or any vendor API.');
    if (rowCount > returnedRows) parts.push(`Showing the first ${returnedRows} rows in chat.`);
    return parts.join(' ');
  }
  // Divo injects a spamScore >= 0 filter to drop the unmeasured sentinel, which
  // changes the result set. Saying so keeps "complete" and "no matches" honest.
  const spamNote = args.operation === 'search_sites' && excludesUnmeasuredSpamScore(args)
    ? ' Sites with no measured spam score were excluded from this request.'
    : '';
  if (status === 'empty') return `OMS returned a valid empty JSON array; no matching sites were found. The response remains provider-limited because OMS supplies neither pagination nor a total.${spamNote}`;
  const parts = [`Retrieved ${rowCount} site row${rowCount === 1 ? '' : 's'}.`];

  if (status === 'partial') {
    // Only search_sites accepts sortBy or filters, so the remedy offered has to
    // match the operation. Suggesting sortBy elsewhere sends the agent into a
    // schema rejection it cannot resolve.
    parts.push(partialAdviceFor(args));
  } else {
    parts.push('This response is under the OMS 100-row cap, but it is still a provider-limited snapshot rather than a claimed exhaustive dataset.');
  }

  parts.push(`OMS never paginates and never reports a total count.${spamNote}`);
  if (rowCount > returnedRows) parts.push(`Showing the first ${returnedRows} rows in chat.`);
  return parts.join(' ');
}

/**
 * Per-operation guidance for a result that came back at the provider's 100-row
 * cap. The provider returns no total and no pagination, so "was truncated" and
 * "happened to match exactly 100" are indistinguishable. The wording therefore
 * says completeness cannot be confirmed rather than asserting rows are missing.
 */
function partialAdviceFor(args: OmsSiteDataToolArgs): string {
  const capped = 'This came back at the OMS 100-row cap, and OMS reports no total, so it may be truncated and completeness cannot be confirmed.';
  if (args.operation === 'list_catalog_values') {
    return `${capped} The field may have further distinct values, and this operation supports no sorting, filtering, or paging to reach them, so do not present it as the full set of options.`;
  }
  if (args.operation === 'get_site_profiles') {
    return `${capped} Sites are stored per listing, so some listings for the requested hostnames may be missing. Request fewer hostnames if you need every listing.`;
  }
  if (args.operation !== 'search_sites') return capped;
  return args.sortBy
    ? `${capped} OMS sorts before it truncates, so these are genuinely the top 100 by ${args.sortBy} ${args.sortDirection ?? defaultSortDirection(args.sortBy)}; any lower-ranked matches are excluded. Narrow the filters to see past them.`
    : `${capped} No sort was requested, so these 100 rows are an arbitrary subset of the matches rather than the best ones. Re-run with sortBy, or narrow the filters, before drawing any conclusion.`;
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
