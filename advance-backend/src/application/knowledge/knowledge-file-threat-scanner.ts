export type KnowledgeThreatScanResult =
  | {
      readonly status: 'clean';
      readonly provider: string;
      readonly engineVersion?: string;
    }
  | {
      readonly status: 'infected';
      readonly provider: string;
      readonly threat: string;
      readonly engineVersion?: string;
    };

/** Bytes-only scanner boundary; filenames and provider paths are never trusted. */
export interface KnowledgeFileThreatScanner {
  scan(input: {
    readonly buffer: Buffer;
    readonly fileName: string;
    readonly mimeType: string;
    readonly signal: AbortSignal;
  }): Promise<KnowledgeThreatScanResult>;
}
