import type {
  DataExportPage,
  DataExportSource,
  DataExportSourceAdapter,
  DataExportSourceContext,
} from './data-export.types';
import { datasetSourceSelection } from './data-export.types';

export class DatasetSourceRegistry {
  private readonly adapters = new Map<
    DataExportSource['kind'],
    DataExportSourceAdapter
  >();

  register<Source extends DataExportSource>(adapter: DataExportSourceAdapter<Source>): void {
    this.adapters.set(adapter.kind, adapter as DataExportSourceAdapter);
  }

  resolve(source: DataExportSource): DataExportSourceAdapter {
    const adapter = this.adapters.get(source.kind);
    if (!adapter) throw new Error(`Unsupported data export source: ${source.kind}`);
    return {
      kind: adapter.kind,
      read: (readSource, context) => this.readWithinSelection(adapter, readSource, context),
    };
  }

  private async *readWithinSelection(
    adapter: DataExportSourceAdapter,
    source: DataExportSource,
    context: DataExportSourceContext,
  ): AsyncIterable<DataExportPage> {
    const selection = datasetSourceSelection(source);
    if (!selection) {
      yield* adapter.read(source, context);
      return;
    }
    if (selection.limit === 0) {
      yield { rows: [], requestedRows: 0 };
      return;
    }

    let rowsToSkip = selection.offset ?? 0;
    let offsetWasApplied = false;
    let remaining = selection.limit;
    for await (const page of adapter.read(source, context)) {
      if (!offsetWasApplied) {
        offsetWasApplied = true;
        rowsToSkip = Math.max(0, rowsToSkip - (page.appliedOffset ?? 0));
      }
      const skipped = Math.min(rowsToSkip, page.rows.length);
      rowsToSkip -= skipped;
      const availableRows = page.rows.slice(skipped);
      const rows = remaining === undefined ? availableRows : availableRows.slice(0, remaining);
      const reachedLimit = remaining !== undefined && rows.length === remaining;
      const hasRowsOutsideWindow = availableRows.length > rows.length;
      if (remaining !== undefined) remaining -= rows.length;
      const requestedWindowSatisfied = reachedLimit && (
        hasRowsOutsideWindow
        || page.hasMore === true
        || page.coverage?.outcome === 'partial'
        || page.coverage?.outcome === 'requested_window_satisfied'
        || page.sourceTruncated === true
      );
      const { hasMore: _hasMore, coverage: pageCoverage, ...pageWithoutFlow } = page;
      yield {
        ...pageWithoutFlow,
        rows,
        ...(selection.limit === undefined ? {} : { requestedRows: selection.limit }),
        ...(requestedWindowSatisfied
          ? { coverage: { outcome: 'requested_window_satisfied' as const, requestedRows: selection.limit! } }
          : pageCoverage ? { coverage: pageCoverage } : {}),
        ...(!reachedLimit && page.hasMore ? { hasMore: true } : {}),
      };
      if (reachedLimit) return;
    }
  }
}
