import * as XLSX from 'xlsx';
import { extractTabularText } from './tabular.extractor';

/** Converts each sheet to CSV and concatenates with a sheet-name header. */
export function extractXlsxText(buf: Buffer): string {
  const workbook = XLSX.read(buf, { type: 'buffer' });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { forceQuotes: false });
    if (!csv.trim()) continue;
    const tableText = extractTabularText(csv);
    parts.push(`## Sheet: ${sheetName}\n\n${tableText}`);
  }

  return parts.join('\n\n');
}
