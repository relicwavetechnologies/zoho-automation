import type {
  DataExportSource,
  DataExportSourceAdapter,
} from './data-export.types';

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
    return adapter;
  }
}
