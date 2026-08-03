export const DATA_EXPORT_XLSX_ROW_LIMIT = 5_000;
export const DATA_EXPORT_XLSX_CELL_LIMIT = 100_000;
export const DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT = 50_000;
export const DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT = 2_000_000;
export const DATA_EXPORT_CSV_ROW_LIMIT = 1_000_000;
export const DATA_EXPORT_GENERIC_SPOOL_BYTE_LIMIT = 1_024 * 1_024 * 1_024;
export const DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT = 200;
export const DATA_EXPORT_MENHOOD_SPOOL_BYTE_LIMIT = DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT * 1_000_000;

export function dataExportRowLimitForFormat(
  format: 'auto' | 'google_sheet' | 'csv' | 'xlsx',
): number {
  if (format === 'xlsx') return DATA_EXPORT_XLSX_ROW_LIMIT;
  if (format === 'google_sheet') return DATA_EXPORT_GOOGLE_SHEET_ROW_LIMIT;
  return DATA_EXPORT_CSV_ROW_LIMIT;
}
