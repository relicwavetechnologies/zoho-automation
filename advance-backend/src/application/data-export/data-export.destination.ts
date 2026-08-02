import type {
  DataExportCompletion,
  DataExportDestination,
} from './data-export.types';

export interface GoogleExportAuth {
  readonly accessToken: string;
  readonly readerDomain: string;
}

export interface DataExportDestinationWriteProgress {
  readonly stage: 'writing';
  readonly rowsProcessed: number;
}

export interface DataExportDestinationWriteInput {
  readonly auth: GoogleExportAuth;
  readonly readerEmail: string;
  readonly exportKey: string;
  readonly destination: DataExportDestination;
  readonly rows: AsyncIterable<readonly Record<string, unknown>[]>;
  readonly sourceTruncated: () => boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
}

export interface DataExportDestinationSink {
  write(input: DataExportDestinationWriteInput): Promise<DataExportCompletion>;
}
