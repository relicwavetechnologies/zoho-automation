import { z } from 'zod';
import type { CanonicalToolId } from '../../domain/tools/tool-id';
import type { ZohoBooksModule } from '../../infrastructure/zoho/zoho-books-paginated.client';

export const DATA_EXPORT_ROW_LIMIT = 5_000;
const ZOHO_BOOKS_SOURCE_MODULES = [
  'contacts', 'invoices', 'estimates', 'creditnotes', 'bills',
  'salesorders', 'purchaseorders', 'customerpayments', 'vendorpayments',
  'bankaccounts', 'banktransactions', 'expenses', 'items',
] as const satisfies readonly ZohoBooksModule[];

export const datasetSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('airtable_records'),
    connectionId: z.string().uuid(),
    toolId: z.enum(['airtableBase', 'airtableRecords']),
    nativeTool: z.enum(['list_records_for_table', 'search_records']),
    input: z.record(z.unknown()),
  }).strict(),
  z.object({
    kind: z.literal('zoho_books'),
    connectionId: z.string().uuid(),
    module: z.enum(ZOHO_BOOKS_SOURCE_MODULES),
    organizationId: z.string().optional(),
    filters: z.record(z.unknown()).optional(),
    query: z.string().optional(),
  }).strict(),
]);

export type DataExportSource = z.infer<typeof datasetSourceSchema>;

export function datasetSourceToolId(source: DataExportSource): CanonicalToolId {
  return source.kind === 'airtable_records' ? source.toolId : 'zohoBooks';
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
  readonly format: 'auto' | 'google_sheet' | 'csv';
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
    };

export interface DataExportCompletion {
  readonly success: true;
  readonly artifactId: string;
  readonly artifactUrl: string;
  readonly artifactType: 'google_sheet' | 'csv';
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
