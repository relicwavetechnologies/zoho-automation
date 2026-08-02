import { z } from 'zod';
import type { CanonicalToolId } from '../../domain/tools/tool-id';
import type { ZohoBooksModule } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { OmsSiteDataToolArgsSchema } from '../oms/oms-site-data.types';
import { SemrushToolArgsSchema } from '../semrush/semrush.types';

export const DATA_EXPORT_ROW_LIMIT = 5_000;
const ZOHO_BOOKS_SOURCE_MODULES = [
  'contacts', 'invoices', 'estimates', 'creditnotes', 'bills',
  'salesorders', 'purchaseorders', 'customerpayments', 'vendorpayments',
  'bankaccounts', 'banktransactions', 'expenses', 'items',
] as const satisfies readonly ZohoBooksModule[];

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

export const directDatasetSourceSchema = z.discriminatedUnion('kind', [
  airtableDatasetSourceSchema,
  zohoBooksDatasetSourceSchema,
]);

export const datasetSourceSchema = z.discriminatedUnion('kind', [
  airtableDatasetSourceSchema,
  zohoBooksDatasetSourceSchema,
  omsSnapshotDatasetSourceSchema,
  semrushSnapshotDatasetSourceSchema,
]);

export type DataExportSource = z.infer<typeof datasetSourceSchema>;

export function datasetSourceToolId(source: DataExportSource): CanonicalToolId {
  if (source.kind === 'airtable_records') return source.toolId;
  if (source.kind === 'zoho_books') return 'zohoBooks';
  return source.kind === 'oms_snapshot' ? 'omsSiteData' : 'semrush';
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
  readonly sourceTruncated: boolean;
  readonly sharedWith: string;
  readonly verified: true;
}

export interface DataExportJobPayload {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly source: DataExportSource;
  readonly transform?: DataExportTransform;
  readonly destination: DataExportDestination;
  readonly chatId: string;
  /** Backend-derived Pi conversation identity; absent only on legacy offers. */
  readonly conversationKey?: string;
  readonly replyToMessageId?: string;
  readonly replyInThread?: boolean;
  readonly requestId: string;
  readonly traceId?: string;
  readonly progressMessageId?: string;
  readonly completedExport?: DataExportCompletion;
}

export interface DataExportPage {
  readonly rows: readonly Record<string, unknown>[];
  readonly hasMore?: boolean;
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
