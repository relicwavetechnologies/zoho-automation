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
import { summarizeSemrushDomainOverview } from '../../semrush/semrush-domain-insights';
import { summarizeSemrushBacklinks } from '../../semrush/semrush-backlinks-insights';
import { SemrushServiceError, SemrushToolArgsSchema, type SemrushFetchedData, type SemrushToolArgs } from '../../semrush/semrush.types';
import type { ApiKeyExhaustionNotifierPort } from '../../governance/api-key-exhaustion.notifier';
import { createDatasetPreview, type DatasetCoverage } from '../../provider-data/dataset-preview';

const ResultSchema = z.object({
  status: z.enum(['complete', 'empty', 'partial', 'blocked']),
  operation: z.string(),
  retrievedAt: z.string(),
  coverage: z.record(z.unknown()),
  preview: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())),
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
  // Counted from the rows the run actually returned. Every number a member asks
  // for out loud lives here, so the model reports one instead of tallying a
  // table by eye — which is how a 26-row answer came back naming 22 countries.
  insights: z.discriminatedUnion('kind', [z.object({
    kind: z.literal('domain_overview'),
    countriesReturned: z.number().int().nonnegative(),
    totalOrganicTraffic: z.number().nonnegative(),
    totalOrganicKeywords: z.number().nonnegative(),
    countriesWithTraffic: z.number().int().nonnegative(),
    countriesWithZeroTraffic: z.number().int().nonnegative(),
    countriesForEightyPercentOfTraffic: z.number().int().nonnegative(),
    tiers: z.object({
      core: z.number().int().nonnegative(),
      emerging: z.number().int().nonnegative(),
      dormant: z.number().int().nonnegative(),
    }).strict(),
    topCountries: z.array(z.object({
      database: z.string(),
      organicTraffic: z.number(),
      trafficSharePct: z.number(),
    }).strict()),
  }).strict(), z.object({
    // Positions run 1..N with no gaps, so a target left out of the written
    // answer is visible. An eleven-site comparison was reported as ten with
    // every printed number correct, which is the failure a count cannot catch.
    kind: z.literal('backlinks_comparison'),
    targetsCompared: z.number().int().nonnegative(),
    targetsWithProviderData: z.number().int().nonnegative(),
    targetsWithoutProviderData: z.array(z.string()),
    ranking: z.array(z.object({
      position: z.number().int().positive(),
      target: z.string(),
      authorityScore: z.number().nullable(),
      backlinks: z.number().nullable(),
      referringDomains: z.number().nullable(),
      hasProviderData: z.boolean(),
    }).strict()),
  }).strict()]).optional(),
  message: z.string(),
});

type Res = z.infer<typeof ResultSchema>;

export const createSemrushTool = (deps: {
  service: SemrushService;
  audit?: AuditService;
  apiKeyExhaustion?: ApiKeyExhaustionNotifierPort;
}): Tool<SemrushToolArgs, Res> => ({
  id: asToolId('semrush'),
  family: 'semrush',
  actionGroups: new Set(['read']),
  argsSchema: SemrushToolArgsSchema,
  resultSchema: ResultSchema,
  description: 'Run read-only Semrush SEO research through backend-configured Semrush web operations. Supports only explicit operations.',
  parameterDocs: [
    'operation: domain_overview, backlinks_comparison, or keyword_position_trend.',
    'domain_overview: { domain, database? }. Rank, organic/paid keywords, traffic and cost for every country database Semrush holds the domain in — one row per country, the requested database first, the rest by organic traffic. Answers "traffic by country" from a single request; read the first row for one country.',
    'backlinks_comparison: { targets[1–10] }. Authority score, total backlinks and referring domains per target in one web request. If Semrush has no report for a requested target, coverage.missingTargets names it as no provider data rather than zero.',
    'keyword_position_trend: { domain, keyword, date, database?, dateType? }. One domain and one keyword, returned as a dated series of positions around the requested date — not a single row. Use for rank on a date and for how that rank moved; not for full keyword lists.',
    'Each supported operation is one bounded provider report, not a pageable dataset. Direct calls return at most 25 preview rows; a protected local-file call returns every row Semrush returned for that report.',
    'Divo rejects arbitrary Semrush endpoints, headers, cookies, export columns, and API keys. Do not claim an unavailable operation has run.',
  ].join('\n'),
  permissionCheck(_args: SemrushToolArgs, perm: PermissionResult) {
    const allowed = perm.allowedActionsByTool.get(asToolId('semrush'))?.has('read') ?? false;
    return allowed
      ? ok('read' as ToolActionGroup)
      : err(new PermissionError({ toolId: 'semrush', action: 'read', reason: 'not_allowed' }));
  },
  async preflight(args: SemrushToolArgs): Promise<Result<Record<string, unknown>, ToolError>> {
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
      const allRows = data.rows;
      const sourceCoverage = previewCoverageFor(data, allRows.length);
      const preview = ctx.resultAudience === 'local_file'
        ? {
            columns: Array.from(new Set(allRows.flatMap(row => Object.keys(row)))),
            rows: allRows,
            coverage: sourceCoverage,
          }
        : createDatasetPreview({ rows: allRows, coverage: sourceCoverage });
      const insights = resultInsights(allRows);
      const result: Res = {
        status: data.status,
        operation: data.operation,
        retrievedAt: new Date().toISOString(),
        coverage: data.coverage,
        preview,
        ...(insights ? { insights } : {}),
        message: messageFor({
          operation: args.operation,
          rowCount: allRows.length,
          returnedRows: preview.rows.length,
          status: data.status,
          missingTargets: stringValues(data.coverage.missingTargets),
          insights,
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
      // A rejected or spent Semrush credential is invisible otherwise: the key
      // lives in backend env, so no member can see that it died and no company
      // admin is told. The notifier dedups per company/provider, so this alerts
      // once. Throttling is excluded — it says nothing about the credential.
      if (normalized.code === 'provider_auth_failed' || normalized.code === 'provider_quota_exhausted') {
        void deps.apiKeyExhaustion?.notifyIfExhausted({
          companyId: ctx.runContext.companyId,
          provider: 'semrush',
          code: normalized.code,
          message: normalized.message,
          source: 'semrush.tool.execute',
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

/** The summaries are readonly by construction; the result schema infers mutable arrays. */
function resultInsights(rows: readonly Readonly<Record<string, unknown>>[]): Res['insights'] {
  const overview = summarizeSemrushDomainOverview(rows);
  if (overview) {
    return {
      ...overview,
      tiers: { ...overview.tiers },
      topCountries: overview.topCountries.map(country => ({ ...country })),
    };
  }
  const backlinks = summarizeSemrushBacklinks(rows);
  if (backlinks) {
    return {
      ...backlinks,
      targetsWithoutProviderData: [...backlinks.targetsWithoutProviderData],
      ranking: backlinks.ranking.map(entry => ({ ...entry })),
    };
  }
  return undefined;
}

function messageFor(input: {
  operation: SemrushToolArgs['operation'];
  rowCount: number;
  returnedRows: number;
  status: Res['status'];
  missingTargets: readonly string[];
  insights?: Res['insights'];
}): string {
  if (input.status === 'empty') return 'Semrush returned no matching data for this request.';
  const parts = [`Retrieved ${input.rowCount} row${input.rowCount === 1 ? '' : 's'}.`];
  // Said here rather than only in the skill because this sentence travels with
  // the rows. Asked which markets a domain is invisible in, the model otherwise
  // answers with countries out of its own knowledge — naming Germany or Japan
  // as unindexed is a measurement Semrush never took, and a member reading the
  // answer cannot tell that apart from one it did.
  if (input.operation === 'domain_overview') {
    parts.push(
      `These ${input.rowCount} countries are every country Semrush returned for this domain.`
      + ' Semrush reported nothing at all about any other country, so do not name one,'
      + ' do not call it unindexed, and do not count how many are missing.'
      + ' A row here showing 0 traffic is a real measurement and can be reported as such.',
    );
  }
  // Handing over the counts removes the step the model kept getting wrong. Any
  // "how many" answer is a field read from here, never a tally of the preview —
  // the preview is capped at 25 rows and counting it undercounts a longer run.
  // A comparison is a list, and a list fails differently from a count: eleven
  // targets were reported as ten with every printed number correct. Numbered
  // positions make the gap visible, so the instruction is to walk them.
  if (input.insights?.kind === 'backlinks_comparison') {
    const { insights } = input;
    parts.push(
      `Ranked ${insights.targetsCompared} targets as positions 1 to ${insights.targetsCompared}`
      + ' in insights.ranking, strongest authority score first.'
      + ' Account for every position when you write the answer — read them off that list rather than'
      + ' from the table, and do not drop one.'
      + (insights.targetsWithoutProviderData.length > 0
        ? ` Semrush returned no report for ${insights.targetsWithoutProviderData.join(', ')}; those rank last and their metrics are null, which is missing data and not a score of zero.`
        : ' Every target returned a report.'),
    );
  }
  if (input.insights?.kind === 'domain_overview') {
    const { insights } = input;
    parts.push(
      `Counted from the rows: ${insights.countriesReturned} countries returned,`
      + ` ${insights.countriesWithTraffic} with organic traffic and ${insights.countriesWithZeroTraffic} measured at zero;`
      + ` ${insights.totalOrganicTraffic.toLocaleString('en-IN')} total organic visits;`
      + ` ${insights.countriesForEightyPercentOfTraffic} ${insights.countriesForEightyPercentOfTraffic === 1 ? 'country accounts' : 'countries account'} for the first 80% of traffic.`
      + ' Quote these numbers rather than counting rows yourself.',
    );
  }
  if (input.rowCount > input.returnedRows) parts.push(`Showing the first ${input.returnedRows} rows in chat.`);
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
  return { kind: 'provider_limited', returnedRows: rowCount, reason: 'semrush_requested_limit_without_pagination_or_total' };
}

function toToolError(error: unknown): ToolError {
  if (error instanceof SemrushServiceError) {
    // Only throttling is retryable. `provider_quota_exhausted` reads like a
    // limit but the same key never recovers, so retrying it just burns the run.
    const reason = error.code === 'timeout' ? 'timeout'
      : error.code === 'capability_unavailable' || error.code === 'not_configured' ? 'bad_args'
        : error.code === 'rate_limited' ? 'retryable'
          : 'upstream_failure';
    return new ToolError({ toolId: 'semrush', reason, message: error.message, cause: error });
  }
  return new ToolError({ toolId: 'semrush', reason: 'upstream_failure', message: error instanceof Error ? error.message : 'Semrush request failed.', cause: error });
}
