/**
 * Delimiter-aware CSV/TSV extractor.
 * Detects delimiter by counting tabs vs commas in the first line.
 * Returns a plain-text table (header | row | row ...) suitable for chunking.
 */
export function extractTabularText(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';

  // Detect delimiter
  const firstLine = lines[0] ?? '';
  const tabCount  = (firstLine.match(/\t/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const delimiter = tabCount > commaCount ? '\t' : ',';

  const parsed = lines.map(line => parseCsvLine(line, delimiter));
  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1);

  const headerLine = headers.join(' | ');
  const separator  = headers.map(() => '---').join(' | ');
  const rowLines   = rows.map(r => {
    // Pad/trim to match header length
    const cells = headers.map((_: string, i: number) => r[i] ?? '');
    return cells.join(' | ');
  });

  return [headerLine, separator, ...rowLines].join('\n');
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
