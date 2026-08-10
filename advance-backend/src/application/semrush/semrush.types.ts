import { z } from 'zod';

/**
 * Only operations with a validated senior `www.semrush.com` recipe are exposed.
 * See docs/SEMRUSH-VALIDATION-NOTES-2026-07-20.md.
 */
export const SEMRUSH_OPERATIONS = [
  'domain_overview',
  'backlinks_comparison',
  'keyword_position_trend',
] as const;

export const SemrushOperationSchema = z.enum(SEMRUSH_OPERATIONS);
export type SemrushOperation = z.infer<typeof SemrushOperationSchema>;

export const SUPPORTED_SEMRUSH_OPERATIONS = [...SEMRUSH_OPERATIONS];

/**
 * Semrush country databases, as two-letter codes.
 *
 * This was an eleven-value enum, which rejected eighteen of the twenty-six
 * databases a single `domain_overview` returns: asking for a keyword's rank in
 * `ru`, `ae` or `vn` failed validation while the same countries appeared in our
 * own results. The list was a guess at Semrush's coverage, and it was wrong in
 * the direction that refuses real data.
 *
 * Semrush is the authority on which codes exist, and it answers an unknown one
 * with an error this client already classifies. So the shape is validated here
 * — two lowercase letters, which is what every observed code is — and coverage
 * is left to the provider. Codes a domain actually has are discoverable: they
 * are the `Database` column of a `domain_overview` for that domain.
 */
export const SemrushDatabaseSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z]{2}$/, 'Use a two-letter Semrush country database code, such as in, us or ru.');

const domain = z.string().trim().min(3).max(253)
  .refine((value) => !/[/?#@:\s]/.test(value) && value.includes('.'), 'Use a bare domain, without protocol, path, credentials, port, or query string.');

const semrushDate = z.string().trim().regex(/^\d{8}$/, 'Use a Semrush date as YYYYMMDD.');

const uniqueTargets = z.array(domain).min(1).max(10).superRefine((targets, ctx) => {
  if (new Set(targets).size !== targets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Comparison targets must be unique.' });
  }
});

export const SemrushToolArgsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('domain_overview'),
    domain,
    database: SemrushDatabaseSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('backlinks_comparison'),
    targets: uniqueTargets,
  }).strict(),
  z.object({
    operation: z.literal('keyword_position_trend'),
    domain,
    keyword: z.string().trim().min(1).max(120),
    date: semrushDate,
    database: SemrushDatabaseSchema.optional(),
    dateType: z.enum(['daily', 'monthly']).optional(),
  }).strict(),
]);

export type SemrushToolArgs = z.infer<typeof SemrushToolArgsSchema>;

export interface SemrushFetchedData {
  readonly operation: SemrushOperation;
  readonly status: 'complete' | 'empty' | 'partial';
  readonly coverage: Record<string, unknown>;
  readonly rows: Array<Record<string, unknown>>;
}

export class SemrushServiceError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'capability_unavailable'
      /** Too fast. The same key works again after a pause. */
      | 'rate_limited'
      /**
       * The key's allowance is spent. Waiting does not help and neither does
       * retrying; only a different key does. Semrush reports this as
       * `Limits exceeded` on `dpa/rpc`, which reads like throttling but
       * persists for hours, so it is kept distinct from `rate_limited`.
       */
      | 'provider_quota_exhausted'
      | 'provider_auth_failed'
      | 'no_more_rows'
      | 'provider_failure'
      | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'SemrushServiceError';
  }
}

export function semrushPreflightLimits(args: SemrushToolArgs): Record<string, number> {
  switch (args.operation) {
    case 'domain_overview':
      return { maxRowsPerRequest: 200 };
    case 'backlinks_comparison':
      return { maxTargets: 10, requestsBilled: 1 };
    case 'keyword_position_trend':
      // Semrush answers with a dated series it sizes itself, so no row cap is
      // claimed here. What the request is bounded by is one domain, one keyword.
      return { maxDomains: 1, maxKeywords: 1 };
  }
}
