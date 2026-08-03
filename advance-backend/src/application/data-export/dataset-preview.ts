export const DATASET_PREVIEW_ROW_LIMIT = 25;

export type DatasetCoverage =
  | { readonly kind: 'complete'; readonly totalRows: number }
  | {
      readonly kind: 'truncated';
      /** Rows observed from the provider before the model preview is capped. */
      readonly returnedRows: number;
      readonly knownTotal?: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'provider_limited';
      /** Rows observed from the provider before the model preview is capped. */
      readonly returnedRows: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'unknown';
      /** Rows observed from the provider before the model preview is capped. */
      readonly returnedRows: number;
    };

export interface DatasetPreview {
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  /** Source truth; returnedRows may exceed rows.length by design. */
  readonly coverage: DatasetCoverage;
  readonly exportOfferId?: string;
  /** Rows the backend counted across every contributing call. */
  readonly exportRowCount?: number;
  /**
   * This run had an export offer and can no longer represent it honestly. The
   * gateway revokes the run's bound offer so no button survives on an answer
   * the export only partly covers.
   */
  readonly exportWithdrawn?: true;
}

export function createDatasetPreview(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly coverage: DatasetCoverage;
  readonly exportOfferId?: string;
  readonly exportRowCount?: number;
  readonly exportWithdrawn?: true;
}): DatasetPreview {
  const rows = input.rows.slice(0, DATASET_PREVIEW_ROW_LIMIT);
  const coverage = input.rows.length > DATASET_PREVIEW_ROW_LIMIT
    && input.coverage.kind === 'complete'
    ? {
        kind: 'truncated' as const,
        returnedRows: rows.length,
        knownTotal: input.coverage.totalRows,
        reason: 'model_preview_limit',
      }
    : input.coverage;
  return {
    columns: Array.from(new Set(rows.flatMap(row => Object.keys(row)))),
    rows,
    coverage,
    ...(input.exportOfferId ? { exportOfferId: input.exportOfferId } : {}),
    ...(input.exportRowCount !== undefined ? { exportRowCount: input.exportRowCount } : {}),
    ...(input.exportWithdrawn ? { exportWithdrawn: true as const } : {}),
  };
}
