import type { CanonicalToolId } from '../../domain/tools/tool-id';
import type { ZohoBooksModule } from '../../infrastructure/zoho/zoho-books-paginated.client';

export const DATA_EXPORT_ROW_LIMIT = 5_000;

export type DataExportSource =
  | {
      readonly kind: 'airtable_records';
      readonly connectionId: string;
      readonly toolId: Extract<CanonicalToolId, 'airtableBase' | 'airtableRecords'>;
      readonly nativeTool: 'list_records_for_table' | 'search_records';
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'zoho_books';
      readonly connectionId: string;
      readonly module: ZohoBooksModule;
      readonly organizationId?: string;
      readonly filters?: Readonly<Record<string, unknown>>;
      readonly query?: string;
    };

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
}

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

export class DataExportSourceRegistry {
  private readonly adapters = new Map<DataExportSource['kind'], DataExportSourceAdapter>();

  register<Source extends DataExportSource>(adapter: DataExportSourceAdapter<Source>): void {
    this.adapters.set(adapter.kind, adapter as DataExportSourceAdapter);
  }

  resolve(source: DataExportSource): DataExportSourceAdapter {
    const adapter = this.adapters.get(source.kind);
    if (!adapter) throw new Error(`Unsupported data export source: ${source.kind}`);
    return adapter;
  }
}
