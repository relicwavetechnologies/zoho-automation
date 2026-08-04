import { z } from 'zod';
import type { CanonicalToolId } from '../../domain/tools/tool-id';
import type { ZohoBooksModule } from '../../infrastructure/zoho/zoho-books-paginated.client';
import type { ZohoCrmModule } from '../../infrastructure/zoho/zoho-crm-paginated.client';
import { MenhoodQueryRequestSchema } from '../menhood/menhood-query';
import { OmsSiteDataToolArgsSchema } from '../oms/oms-site-data.types';
import { SemrushToolArgsSchema } from '../semrush/semrush.types';

export {
  DATA_EXPORT_CSV_ROW_LIMIT as DATA_EXPORT_ROW_LIMIT,
} from './data-export-limits';

const ZOHO_BOOKS_SOURCE_MODULES = [
  'contacts', 'invoices', 'estimates', 'creditnotes', 'bills',
  'salesorders', 'purchaseorders', 'customerpayments', 'vendorpayments',
  'bankaccounts', 'banktransactions', 'expenses', 'items',
] as const satisfies readonly ZohoBooksModule[];
const ZOHO_CRM_SOURCE_MODULES = [
  'Leads', 'Contacts', 'Accounts', 'Deals', 'Tasks',
] as const satisfies readonly ZohoCrmModule[];

const airtableDatasetSourceSchema = z.object({
  kind: z.literal('airtable_records'),
  connectionId: z.string().uuid(),
  toolId: z.enum(['airtableBase', 'airtableRecords']),
  nativeTool: z.enum(['list_records_for_table', 'search_records']),
  input: z.record(z.unknown()),
}).strict();
const zohoBooksDatasetSourceSchema = z.object({
  kind: z.literal('zoho_books'),
  connectionId: z.string().uuid(),
  module: z.enum(ZOHO_BOOKS_SOURCE_MODULES),
  organizationId: z.string().optional(),
  filters: z.record(z.unknown()).optional(),
  query: z.string().optional(),
}).strict();
const zohoCrmDatasetSourceSchema = z.object({
  kind: z.literal('zoho_crm'),
  connectionId: z.string().uuid(),
  module: z.enum(ZOHO_CRM_SOURCE_MODULES),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
}).strict();
const omsSnapshotDatasetSourceSchema = z.object({
  kind: z.literal('oms_snapshot'),
  connectionId: z.literal('backend_managed'),
  args: OmsSiteDataToolArgsSchema,
}).strict();
const semrushSnapshotDatasetSourceSchema = z.object({
  kind: z.literal('semrush_snapshot'),
  connectionId: z.literal('backend_managed'),
  args: SemrushToolArgsSchema,
}).strict();
const menhoodQueryDatasetSourceSchema = z.object({
  kind: z.literal('menhood_query'),
  connectionId: z.literal('backend_managed'),
  query: MenhoodQueryRequestSchema,
  queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/**
 * Filter keys a provider refuses to honour on their own.
 *
 * A recipe is a promise replayed later: whatever the member is told, the export
 * only exists once this exact request succeeds at confirmation time. A filter
 * combination the provider rejects therefore has to fail here, while the model
 * can still repair it or ask, rather than after "your export has been queued".
 *
 * Only combinations verified against the live provider belong in this table.
 * A guessed rule blocks a working export, which is the same failure in the
 * other direction.
 */
const ZOHO_BOOKS_FILTER_COMPANIONS: readonly {
  readonly module: (typeof ZOHO_BOOKS_SOURCE_MODULES)[number];
  readonly whenAnyOf: readonly string[];
  readonly requires: string;
  readonly message: string;
}[] = [
  {
    // Verified against Zoho Books: /banktransactions?status=… without an
    // account answers 400 {"code":4,"message":"The account does not exist."},
    // and succeeds the moment account_id is supplied.
    module: 'banktransactions',
    whenAnyOf: ['status', 'filter_by'],
    requires: 'account_id',
    message:
      'Zoho Books rejects a bank transaction status filter that does not name an account. '
      + 'Add account_id (the bank account this statement is for) to the source filters.',
  },
];

const datasetSourceUnion = z.discriminatedUnion('kind', [
  airtableDatasetSourceSchema,
  zohoBooksDatasetSourceSchema,
  zohoCrmDatasetSourceSchema,
  omsSnapshotDatasetSourceSchema,
  semrushSnapshotDatasetSourceSchema,
  menhoodQueryDatasetSourceSchema,
]);

function refineDatasetSource(
  source: z.infer<typeof datasetSourceUnion>,
  ctx: z.RefinementCtx,
): void {
  if (source.kind !== 'zoho_books' || !source.filters) return;
  const filters = source.filters;
  for (const rule of ZOHO_BOOKS_FILTER_COMPANIONS) {
    if (source.module !== rule.module) continue;
    if (!rule.whenAnyOf.some(key => filters[key] !== undefined)) continue;
    if (filters[rule.requires] !== undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['filters', rule.requires],
      message: rule.message,
    });
  }
}

export const directDatasetSourceSchema = z.discriminatedUnion('kind', [
  airtableDatasetSourceSchema,
  zohoBooksDatasetSourceSchema,
]).superRefine(refineDatasetSource);

export const datasetSourceSchema = datasetSourceUnion.superRefine(refineDatasetSource);

export type DataExportSource = z.infer<typeof datasetSourceSchema>;

export function datasetSourceToolId(source: DataExportSource): CanonicalToolId {
  if (source.kind === 'airtable_records') return source.toolId;
  if (source.kind === 'zoho_books') return 'zohoBooks';
  if (source.kind === 'zoho_crm') return 'zohoCrm';
  if (source.kind === 'menhood_query') return 'menhoodData';
  return source.kind === 'oms_snapshot' ? 'omsSiteData' : 'semrush';
}

/**
 * Identifies the row shape a source produces, so one export never unions
 * columns that were never meant to sit in one table.
 *
 * Kind alone is too coarse. A single Semrush run can mix `domain_overview`
 * (one row per domain) with `organic_positions` (many rows for one domain);
 * folding those together yields a sparse sheet nobody asked for. Parts merge
 * only when this key matches exactly.
 */
export function datasetSourceShapeKey(source: DataExportSource): string {
  // Every key carries the connection: the same module read through two
  // different accounts is two datasets, and the offer row's indexed
  // `sourceConnectionId` only ever describes part 0.
  const scope = `${source.kind}:${source.connectionId}`;
  switch (source.kind) {
    case 'airtable_records':
      return [
        scope,
        source.toolId,
        source.nativeTool,
        String(source.input['tableId'] ?? ''),
        // `fieldIds` is what selects the columns, so two reads of one table
        // with different field sets produce different rows.
        Array.isArray(source.input['fieldIds'])
          ? [...source.input['fieldIds'] as unknown[]].map(String).sort().join(',')
          : '',
      ].join(':');
    case 'zoho_books':
    case 'zoho_crm':
      return `${scope}:${source.module}`;
    case 'oms_snapshot':
    case 'semrush_snapshot':
      return `${scope}:${source.args.operation}`;
    case 'menhood_query':
      return `${scope}:${source.queryFingerprint}`;
  }
}

/**
 * The member-selected row window for one source part.
 *
 * This is deliberately resolved from each recipe part rather than the export
 * payload: one offer can contain several compatible source reads, each with a
 * different window.
 */
export interface DatasetSourceSelection {
  readonly limit?: number;
  readonly offset?: number;
}

export function datasetSourceSelection(source: DataExportSource): DatasetSourceSelection | undefined {
  if (source.kind === 'airtable_records') {
    const maxRecords = source.input['maxRecords'];
    return typeof maxRecords === 'number'
      && Number.isSafeInteger(maxRecords)
      && maxRecords >= 0
      ? { limit: maxRecords }
      : undefined;
  }
  if (source.kind !== 'semrush_snapshot' || source.args.operation === 'organic_position_trend') {
    return undefined;
  }
  const limit = 'limit' in source.args ? source.args.limit : undefined;
  const offset = source.args.operation === 'organic_positions'
    ? source.args.offset
    : undefined;
  return limit === undefined && offset === undefined
    ? undefined
    : {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      };
}

export interface DataExportTransform {
  /**
   * Function body executed once per source row. It receives `row`, `index`,
   * and `args`, and must return one object, an array of objects, or null.
   */
  readonly script: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface DataExportDestination {
  readonly format: 'auto' | 'google_sheet' | 'csv' | 'xlsx';
  readonly title: string;
  readonly columns?: readonly string[];
  /** Backend-resolved at confirmation time; never accepted from model input. */
  readonly target?: DataExportDestinationTarget;
}

export type DataExportDestinationTarget =
  | {
      readonly kind: 'user_google';
      readonly connectionId: string;
    }
  | {
      readonly kind: 'company_google';
      readonly connectionId: string;
    }
  | {
      readonly kind: 'existing_google_sheet';
      readonly connectionId: string;
      readonly spreadsheetId: string;
      readonly gid?: string;
      readonly mode: 'new_tab';
    };

export interface DataExportCompletion {
  readonly success: true;
  readonly artifactId: string;
  readonly artifactUrl: string;
  readonly artifactType: 'google_sheet' | 'csv' | 'xlsx';
  readonly rowCount: number;
  /** Present for exports completed after coverage causes were introduced. */
  readonly coverage?: DataExportCoverage;
  /** Compatibility for completed jobs and Drive metadata written before coverage. */
  readonly sourceTruncated: boolean;
  readonly sharedWith: string;
  readonly verified: true;
}

export type DataExportCoverageCause =
  | 'provider_limit'
  | 'export_row_cap'
  | 'destination_row_cap'
  | 'destination_cell_cap'
  | 'spool_cap';

export interface DataExportCoverage {
  readonly requestedRows?: number;
  readonly inputRowsRead: number;
  readonly rowsWritten: number;
  readonly outcome: 'complete' | 'requested_window_satisfied' | 'partial';
  readonly cause?: DataExportCoverageCause;
  readonly knownOmittedRows?: number;
}

export type DataExportSourceCoverage =
  | {
      readonly outcome: 'requested_window_satisfied';
      readonly requestedRows: number;
    }
  | {
      readonly outcome: 'partial';
      readonly cause: 'provider_limit';
      readonly knownOmittedRows?: number;
    };

export interface DataExportJobPayload {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly source: DataExportSource;
  /**
   * Parts 1..N when one run built its table from several tool calls — 22
   * `domain_overview` lookups are 22 parts of one 22-row table. Every part
   * shares `source`'s shape key. Part 0 stays in `source` so offers persisted
   * before this existed, and the offer row's indexed `sourceKind` /
   * `sourceConnectionId` columns, keep parsing unchanged.
   */
  readonly additionalParts?: readonly DataExportSource[];
  /**
   * Rows the run actually observed across every part. Lets the offer state a
   * count it measured instead of one the model narrated.
   */
  readonly observedRowCount?: number;
  readonly transform?: DataExportTransform;
  readonly destination: DataExportDestination;
  /** Sample jobs share the exporter but use different member-facing copy. */
  readonly exportKind?: 'sample' | 'full';
  /** Backend-set row ceiling for sample/preflight artifacts. */
  readonly rowLimitOverride?: number;
  readonly sampleOfPlanId?: string;
  readonly chatId: string;
  /** Backend-derived Pi conversation identity; absent only on legacy offers. */
  readonly conversationKey?: string;
  readonly replyToMessageId?: string;
  readonly replyInThread?: boolean;
  readonly requestId: string;
  readonly traceId?: string;
  readonly progressMessageId?: string;
  readonly completedExport?: DataExportCompletion;
  /**
   * When the model plans a multi-tab workbook, each entry is replayed into its
   * own Sheet tab or Excel worksheet. Mutually exclusive with flat
   * `additionalParts` merging for the same job.
   */
  readonly workbookTabs?: readonly {
    readonly source: DataExportSource;
    readonly tabName: string;
  }[];
}

/** Every source this payload reads, in the order the run produced them. */
export function dataExportParts(
  payload: Pick<DataExportJobPayload, 'source' | 'additionalParts'>,
): readonly DataExportSource[] {
  return [payload.source, ...(payload.additionalParts ?? [])];
}

export interface DataExportPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly hasMore?: boolean;
  /** Source offset already applied before this page's rows, when known. */
  readonly appliedOffset?: number;
  /** The source's row window, if this operation has one. */
  readonly requestedRows?: number;
  /** Source-only coverage facts. The worker owns the final export receipt. */
  readonly coverage?: DataExportSourceCoverage;
  /** Compatibility for sources not yet migrated to `coverage`. */
  readonly sourceTruncated?: boolean;
}

export interface DataExportSourceContext {
  readonly companyId: string;
  readonly userId: string;
  readonly signal?: AbortSignal;
}

export interface DataExportSourceAdapter<Source extends DataExportSource = DataExportSource> {
  readonly kind: Source['kind'];
  read(source: Source, context: DataExportSourceContext): AsyncIterable<DataExportPage>;
}
