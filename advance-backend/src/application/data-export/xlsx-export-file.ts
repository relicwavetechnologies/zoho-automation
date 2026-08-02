import * as XLSX from 'xlsx';
import { normalizeExportCell } from './data-export-cell';
import type { DataExportDestinationWriteProgress } from './data-export.destination';

export const XLSX_MAX_ROWS = 5_000;
export const XLSX_MAX_CELLS = 100_000;
export const XLSX_MAX_COLUMNS = 16_384;
const XLSX_APPEND_ROWS = 500;

export async function writeXlsxArtifact(input: {
  readonly path: string;
  readonly columns: readonly string[];
  readonly rows: AsyncIterable<Record<string, unknown>>;
  readonly rowCount: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DataExportDestinationWriteProgress) => Promise<void>;
}): Promise<void> {
  if (input.columns.length === 0) {
    throw new Error('Excel export requires at least one output column');
  }
  if (
    input.rowCount > XLSX_MAX_ROWS
    || input.columns.length > XLSX_MAX_COLUMNS
    || (input.rowCount + 1) * input.columns.length > XLSX_MAX_CELLS
  ) {
    throw new Error(
      `Excel export exceeds the ${XLSX_MAX_ROWS.toLocaleString('en-IN')}-row, ${XLSX_MAX_COLUMNS.toLocaleString('en-IN')}-column, or ${XLSX_MAX_CELLS.toLocaleString('en-IN')}-cell safety ceiling; use CSV`,
    );
  }

  const sheet = XLSX.utils.aoa_to_sheet([[...input.columns]]);
  let batch: unknown[][] = [];
  let writtenRows = 0;
  for await (const row of input.rows) {
    input.signal?.throwIfAborted();
    batch.push(input.columns.map(column => normalizeExportCell(row[column])));
    writtenRows += 1;
    if (batch.length < XLSX_APPEND_ROWS) continue;
    XLSX.utils.sheet_add_aoa(sheet, batch, { origin: -1 });
    batch = [];
    await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
  }
  if (batch.length > 0) {
    XLSX.utils.sheet_add_aoa(sheet, batch, { origin: -1 });
  }
  await input.onProgress?.({ stage: 'writing', rowsProcessed: writtenRows });
  if (writtenRows !== input.rowCount) {
    throw new Error('Excel export verification failed: spool row count changed while writing');
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Export');
  await writeWorkbook(input.path, workbook);
  verifyWorkbook(input.path, input.columns, input.rowCount);
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
): void {
  const workbook = XLSX.readFile(path, { dense: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
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
}
