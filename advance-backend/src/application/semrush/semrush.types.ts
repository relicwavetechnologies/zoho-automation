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

/** Operations are deliberately explicit. Unsupported rows are never tunneled to Semrush. */
export const operationApiVersion: Record<SemrushOperation, 'v3' | null> = {
  domain_overview: 'v3',
  organic_positions: 'v3',
  backlinks_comparison: null,
  // These remain unavailable until P0 proves an official endpoint, entitlement,
  // cost model, and response fixture for each of them.
  organic_position_trend: null,
  domain_comparison: null,
  keyword_gap: null,
  keyword_research: null,
};

export const SUPPORTED_SEMRUSH_OPERATIONS = Object.entries(operationApiVersion)
  .filter(([, version]) => version !== null)
  .map(([operation]) => operation) as Array<Extract<SemrushOperation, 'domain_overview' | 'organic_positions'>>;

const DATABASES = ['in', 'us', 'uk', 'au', 'ca', 'de', 'fr', 'es', 'it', 'br', 'jp'] as const;
export const SemrushDatabaseSchema = z.enum(DATABASES);

const domain = z.string().trim().min(3).max(253)
  .refine((value) => !/[/?#@:\s]/.test(value) && value.includes('.'), 'Use a bare domain, without protocol, path, credentials, port, or query string.');

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
  z.object({
    operation: z.literal('backlinks_comparison'),
    targets: z.array(domain).min(2).max(10).superRefine((targets, ctx) => {
      if (new Set(targets).size !== targets.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Comparison targets must be unique.' });
    }),
    exportCsv: z.boolean().optional(),
  }).strict(),
  // Known product capabilities that are intentionally unavailable until an
  // official API contract is verified. Keeping explicit schemas avoids a
  // generic provider escape hatch and gives callers an honest error.
  z.object({ operation: z.literal('organic_position_trend'), domain, database: SemrushDatabaseSchema.optional() }).strict(),
  z.object({ operation: z.literal('domain_comparison'), targets: z.array(domain).min(2).max(25) }).strict(),
  z.object({ operation: z.literal('keyword_gap'), targets: z.array(domain).min(2).max(5), database: SemrushDatabaseSchema.optional() }).strict(),
  z.object({ operation: z.literal('keyword_research'), keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(25), database: SemrushDatabaseSchema.optional() }).strict(),
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
