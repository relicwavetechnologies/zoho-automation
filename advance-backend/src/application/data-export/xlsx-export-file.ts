import * as XLSX from 'xlsx';
import type { DataExportDestinationWriteProgress } from './data-export.destination';
import { buildDataExportPresentation } from './data-export-presentation';
import type { DataExportCoverage, DataExportSource } from './data-export.types';
import {
  DATA_EXPORT_XLSX_CELL_LIMIT as XLSX_MAX_CELLS,
  DATA_EXPORT_XLSX_ROW_LIMIT as XLSX_MAX_ROWS,
} from './data-export-limits';

export { XLSX_MAX_CELLS, XLSX_MAX_ROWS };
export const XLSX_MAX_COLUMNS = 16_384;
const XLSX_APPEND_ROWS = 500;
const XLSX_MIN_COLUMN_WIDTH = 10;
const XLSX_MAX_COLUMN_WIDTH = 40;
type DataExportPresentation = ReturnType<typeof buildDataExportPresentation>;

export function dataExportPresentationCellCount(
  presentation: DataExportPresentation,
  rowCount: number,
): number {
  const cellsPerDataRow = Math.max(
    1,
    presentation.mainColumns.length + (presentation.trends?.columns.length ?? 0),
  );
  const overviewCells = presentation.overviewRows?.reduce(
    (count, row) => count + row.length,
    0,
  ) ?? 0;
  return (rowCount + 1) * cellsPerDataRow + overviewCells;
}

export function dataExportPresentationRowLimit(
  presentation: DataExportPresentation,
  cellLimit: number,
): number {
  const cellsPerDataRow = Math.max(
    1,
    presentation.mainColumns.length + (presentation.trends?.columns.length ?? 0),
  );
  const overviewCells = presentation.overviewRows?.reduce(
    (count, row) => count + row.length,
    0,
  ) ?? 0;
  return Math.max(0, Math.floor((cellLimit - overviewCells) / cellsPerDataRow) - 1);
}

export async function writeXlsxArtifact(input: {
  readonly path: string;
  readonly title?: string;
  readonly columns: readonly string[];
  readonly source?: DataExportSource;
  readonly coverage?: DataExportCoverage;
  readonly sourceTruncated?: boolean;
  readonly rows: AsyncIterable<Record<string, unknown>>;
  readonly rowCount: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
}): Promise<void> {
  if (input.columns.length === 0) {
    throw new Error('Excel export requires at least one output column');
  }
  const presentation = buildDataExportPresentation({
    title: input.title ?? 'Export',
    columns: input.columns,
    ...(input.source ? { source: input.source } : {}),
    rowCount: input.rowCount,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    sourceTruncated: input.sourceTruncated ?? false,
  });
  if (
    input.rowCount > XLSX_MAX_ROWS
    || input.columns.length > XLSX_MAX_COLUMNS
    || dataExportPresentationCellCount(presentation, input.rowCount) > XLSX_MAX_CELLS
  ) {
    throw new Error(
      `Excel export exceeds the ${XLSX_MAX_ROWS.toLocaleString('en-IN')}-row, ${XLSX_MAX_COLUMNS.toLocaleString('en-IN')}-column, or ${XLSX_MAX_CELLS.toLocaleString('en-IN')}-cell safety ceiling; use CSV`,
    );
  }

  const sheet = XLSX.utils.aoa_to_sheet([[...presentation.mainColumns]]);
  const trendSheet = presentation.trends
    ? XLSX.utils.aoa_to_sheet([[...presentation.trends.columns]])
    : undefined;
  const columnWidths = presentation.mainColumns.map(column => visibleWidth(column));
  const trendColumnWidths = presentation.trends?.columns.map(column => visibleWidth(column));
  let batch: unknown[][] = [];
  let trendBatch: unknown[][] = [];
  let writtenRows = 0;
  for await (const row of input.rows) {
    input.signal?.throwIfAborted();
    const values = [...presentation.mainRow(row)];
    values.forEach((value, index) => {
      columnWidths[index] = Math.max(columnWidths[index] ?? 0, visibleWidth(value));
    });
    batch.push(values);
    if (trendSheet && presentation.trends) {
      const trendValues = [...presentation.trendRow(row)];
      trendValues.forEach((value, index) => {
        if (trendColumnWidths) {
          trendColumnWidths[index] = Math.max(
            trendColumnWidths[index] ?? 0,
            visibleWidth(value),
          );
        }
      });
      trendBatch.push(trendValues);
    }
    writtenRows += 1;
    if (batch.length < XLSX_APPEND_ROWS) continue;
    XLSX.utils.sheet_add_aoa(sheet, batch, { origin: -1 });
    if (trendSheet && trendBatch.length > 0) {
      XLSX.utils.sheet_add_aoa(trendSheet, trendBatch, { origin: -1 });
    }
    batch = [];
    trendBatch = [];
    await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
  }
  if (batch.length > 0) {
    XLSX.utils.sheet_add_aoa(sheet, batch, { origin: -1 });
  }
  if (trendSheet && trendBatch.length > 0) {
    XLSX.utils.sheet_add_aoa(trendSheet, trendBatch, { origin: -1 });
  }
  await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
  if (writtenRows !== input.rowCount) {
    throw new Error('Excel export verification failed: spool row count changed while writing');
  }

  sheet['!cols'] = columnWidths.map(width => ({
    wch: Math.min(XLSX_MAX_COLUMN_WIDTH, Math.max(XLSX_MIN_COLUMN_WIDTH, width + 2)),
  }));
  sheet['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { c: 0, r: 0 },
      e: { c: presentation.mainColumns.length - 1, r: writtenRows },
    }),
  };
  if (trendSheet && presentation.trends && trendColumnWidths) {
    trendSheet['!cols'] = trendColumnWidths.map(width => ({
      wch: Math.min(XLSX_MAX_COLUMN_WIDTH, Math.max(XLSX_MIN_COLUMN_WIDTH, width + 2)),
    }));
    trendSheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { c: 0, r: 0 },
        e: { c: presentation.trends.columns.length - 1, r: writtenRows },
      }),
    };
  }
  applyNumberFormats(sheet, presentation.mainColumns, writtenRows, presentation.numberFormats);
  if (trendSheet && presentation.trends) {
    applyNumberFormats(
      trendSheet,
      presentation.trends.columns,
      writtenRows,
      presentation.numberFormats,
    );
  }

  const workbook = XLSX.utils.book_new();
  if (presentation.overviewRows) {
    const overview = XLSX.utils.aoa_to_sheet(presentation.overviewRows.map(row => [...row]));
    overview['!cols'] = [{ wch: 22 }, { wch: 72 }];
    XLSX.utils.book_append_sheet(workbook, overview, 'Overview');
  }
  XLSX.utils.book_append_sheet(workbook, sheet, presentation.dataSheetTitle);
  if (trendSheet && presentation.trends) {
    XLSX.utils.book_append_sheet(workbook, trendSheet, presentation.trends.title);
  }
  await writeWorkbook(input.path, workbook);
  verifyWorkbook(
    input.path,
    presentation.mainColumns,
    input.rowCount,
    presentation.dataSheetTitle,
    presentation.trends,
  );
}

function applyNumberFormats(
  sheet: XLSX.WorkSheet,
  columns: readonly string[],
  rowCount: number,
  formats: Readonly<Record<string, string>>,
): void {
  for (const [columnIndex, column] of columns.entries()) {
    const format = formats[column];
    if (!format) continue;
    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ c: columnIndex, r: rowIndex })];
      if (cell?.t === 'n') cell.z = format;
    }
  }
}

function visibleWidth(value: unknown): number {
  return String(value ?? '')
    .split(/\r?\n/u)
    .reduce((width, line) => Math.max(width, [...line].length), 0);
}

function writeWorkbook(path: string, workbook: XLSX.WorkBook): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeFileAsync = XLSX.writeFileAsync as unknown as (
      filename: string,
      data: XLSX.WorkBook,
      options: XLSX.WritingOptions,
      callback: (error?: Error | null) => void,
    ) => void;
    writeFileAsync(path, workbook, { bookType: 'xlsx', compression: true }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function verifyWorkbook(
  path: string,
  columns: readonly string[],
  rowCount: number,
  sheetName: string,
  trends?: { readonly title: string; readonly columns: readonly string[] },
): void {
  const workbook = XLSX.readFile(path, { dense: true });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('Excel export verification failed: workbook has no worksheet');
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    blankrows: true,
  });
  if (rows.length !== rowCount + 1) {
    throw new Error('Excel export verification failed: worksheet row count differs from export');
  }
  const header = rows[0] ?? [];
  if (
    header.length !== columns.length
    || columns.some((column, index) => header[index] !== column)
  ) {
    throw new Error('Excel export verification failed: worksheet headers differ from export');
  }
  if (!trends) return;
  const trendSheet = workbook.Sheets[trends.title];
  if (!trendSheet) throw new Error('Excel export verification failed: trends worksheet is missing');
  const trendRows = XLSX.utils.sheet_to_json<unknown[]>(trendSheet, {
    header: 1,
    raw: true,
    blankrows: true,
  });
  if (trendRows.length !== rowCount + 1) {
    throw new Error('Excel export verification failed: trends row count differs from export');
  }
  const trendHeader = trendRows[0] ?? [];
  if (
    trendHeader.length !== trends.columns.length
    || trends.columns.some((column, index) => trendHeader[index] !== column)
  ) {
    throw new Error('Excel export verification failed: trends headers differ from export');
  }
}
