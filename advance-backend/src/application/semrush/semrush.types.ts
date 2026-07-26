import { z } from 'zod';

export const SEMRUSH_OPERATIONS = [
  'domain_overview',
  'organic_positions',
  'organic_position_trend',
  'backlinks_comparison',
  'domain_comparison',
  'keyword_gap',
  'keyword_research',
] as const;

export const SemrushOperationSchema = z.enum(SEMRUSH_OPERATIONS);
export type SemrushOperation = z.infer<typeof SemrushOperationSchema>;

/**
 * Operations are deliberately explicit. Unsupported rows are never tunneled to
 * Semrush. Each entry names the official API surface the operation runs on:
 * `v3` is the standard reports host, `analytics_v1` is the separate Backlinks
 * host, which takes a different base path and one target per call.
 */
export const operationApiVersion: Record<SemrushOperation, 'v3' | 'analytics_v1' | null> = {
  domain_overview: 'v3',
  organic_positions: 'v3',
  organic_position_trend: 'v3',
  domain_comparison: 'v3',
  keyword_gap: 'v3',
  keyword_research: 'v3',
  backlinks_comparison: 'analytics_v1',
};

export const SUPPORTED_SEMRUSH_OPERATIONS = Object.entries(operationApiVersion)
  .filter(([, version]) => version !== null)
  .map(([operation]) => operation) as SemrushOperation[];

/** `domain_domains` returns HTTP 200 "Internal Server Error" beyond five domains. */
export const MAX_COMPARISON_TARGETS = 5;

const DATABASES = ['in', 'us', 'uk', 'au', 'ca', 'de', 'fr', 'es', 'it', 'br', 'jp'] as const;
export const SemrushDatabaseSchema = z.enum(DATABASES);

const domain = z.string().trim().min(3).max(253)
  .refine((value) => !/[/?#@:\s]/.test(value) && value.includes('.'), 'Use a bare domain, without protocol, path, credentials, port, or query string.');

/** Shared by every multi-domain operation; each caps the count for its own endpoint. */
const uniqueTargets = z.array(domain).min(2).max(10).superRefine((targets, ctx) => {
  if (new Set(targets).size !== targets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Comparison targets must be unique.' });
  }
});

const pagination = z.object({
  limit: z.number().int().min(1).max(1_000).optional(),
  offset: z.number().int().min(0).max(9_000).optional(),
}).strict();

export const SemrushToolArgsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('domain_overview'),
    domain,
    database: SemrushDatabaseSchema.optional(),
    exportCsv: z.boolean().optional(),
  }).strict(),
  z.object({
    operation: z.literal('organic_positions'),
    domain,
    database: SemrushDatabaseSchema.optional(),
    ...pagination.shape,
    exportCsv: z.boolean().optional(),
  }).strict(),
  // The Backlinks host accepts one target per call, so this operation costs one
  // request per domain. That is why it is bounded more tightly than it looks.
  z.object({
    operation: z.literal('backlinks_comparison'),
    targets: uniqueTargets,
    exportCsv: z.boolean().optional(),
  }).strict(),
  z.object({
    operation: z.literal('organic_position_trend'),
    domain,
    database: SemrushDatabaseSchema.optional(),
    limit: z.number().int().min(1).max(120).optional(),
  }).strict(),
  // Both comparison operations run on `domain_domains`, which caps at five
  // domains. domain_comparison overlaps every target; keyword_gap excludes the
  // first so the result is what the competitors rank for and it does not.
  z.object({
    operation: z.literal('domain_comparison'),
    targets: uniqueTargets.refine(list => list.length <= MAX_COMPARISON_TARGETS, `Compare at most ${MAX_COMPARISON_TARGETS} domains.`),
    database: SemrushDatabaseSchema.optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  }).strict(),
  z.object({
    operation: z.literal('keyword_gap'),
    targets: uniqueTargets.refine(list => list.length <= MAX_COMPARISON_TARGETS, `Compare at most ${MAX_COMPARISON_TARGETS} domains.`),
    database: SemrushDatabaseSchema.optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  }).strict(),
  z.object({
    operation: z.literal('keyword_research'),
    keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(25)
      .refine(list => list.every(item => !item.includes(';')), 'Semrush separates batched keywords with ";", so a keyword cannot contain one.')
      .refine(list => new Set(list.map(item => item.toLowerCase())).size === list.length, 'Keywords must be unique.'),
    database: SemrushDatabaseSchema.optional(),
  }).strict(),
]);

export type SemrushToolArgs = z.infer<typeof SemrushToolArgsSchema>;

export interface SemrushFetchedData {
  readonly operation: SemrushOperation;
  readonly status: 'complete' | 'empty' | 'partial';
  readonly coverage: Record<string, unknown>;
  readonly rows: Array<Record<string, unknown>>;
  readonly nextPage?: string;
}

export class SemrushServiceError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'capability_unavailable'
      | 'rate_limited'
      | 'provider_auth_failed'
      | 'provider_insufficient_units'
      | 'provider_failure'
      | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'SemrushServiceError';
  }
}
