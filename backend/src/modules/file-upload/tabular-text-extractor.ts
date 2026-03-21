type Delimiter = ',' | ';' | '\t' | '|';

const CANDIDATE_DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

const normalizeCell = (value: string): string =>
  value
    .replace(/\r?\n+/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();

const stripBom = (value: string): string =>
  value.startsWith('\uFEFF') ? value.slice(1) : value;

const countDelimiterOutsideQuotes = (line: string, delimiter: Delimiter): number => {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }

  return count;
};

const detectDelimiter = (rawText: string): Delimiter => {
  const sampleLines = stripBom(rawText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

  if (sampleLines.length === 0) return ',';

  let bestDelimiter: Delimiter = ',';
  let bestScore = -1;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = sampleLines.map((line) => countDelimiterOutsideQuotes(line, delimiter));
    const populatedCounts = counts.filter((count) => count > 0);
    if (populatedCounts.length === 0) continue;

    const totalDelimiters = populatedCounts.reduce((sum, count) => sum + count, 0);
    const consistency = populatedCounts.length / sampleLines.length;
    const score = totalDelimiters + consistency;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }

  return bestDelimiter;
};

const parseDelimitedRows = (rawText: string, delimiter: Delimiter): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = '';
  };

  const pushRow = () => {
    const normalizedRow = row.map((value) => normalizeCell(value));
    const hasContent = normalizedRow.some(Boolean);
    if (hasContent) {
      rows.push(normalizedRow);
    }
    row = [];
  };

  const text = stripBom(rawText);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      pushCell();
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      pushCell();
      pushRow();
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    pushCell();
    pushRow();
  }

  return rows;
};

const looksLikeHeaderRow = (rows: string[][]): boolean => {
  if (rows.length < 2) return false;

  const [firstRow, secondRow] = rows;
  const populatedCells = firstRow.filter(Boolean);
  if (populatedCells.length === 0) return false;
  if (!populatedCells.some((cell) => /[A-Za-z]/.test(cell))) return false;

  const uniqueCells = new Set(populatedCells.map((cell) => cell.toLowerCase()));
  if (uniqueCells.size !== populatedCells.length) return false;

  const secondRowLooksLikeData = secondRow.some((cell) =>
    Boolean(cell) && (/[0-9]/.test(cell) || /[-/]/.test(cell) || cell.toLowerCase() !== cell.toUpperCase()),
  );

  return secondRowLooksLikeData;
};

const buildHeaders = (row: string[], width: number): string[] =>
  Array.from({ length: width }, (_, index) => {
    const rawHeader = row[index] ?? '';
    return rawHeader || `Column ${index + 1}`;
  });

export const extractTabularText = (input: {
  fileName: string;
  rawText: string;
  delimiter?: Delimiter;
}): string => {
  const delimiter = input.delimiter ?? detectDelimiter(input.rawText);
  const parsedRows = parseDelimitedRows(input.rawText, delimiter);
  const width = parsedRows.reduce((max, row) => Math.max(max, row.length), 0);

  if (parsedRows.length === 0 || width === 0) {
    return '';
  }

  if (width === 1 && parsedRows.length <= 1) {
    return stripBom(input.rawText).trim();
  }

  const hasHeaderRow = looksLikeHeaderRow(parsedRows);
  const headerRow = hasHeaderRow ? parsedRows[0] : [];
  const headers = buildHeaders(headerRow, width);
  const dataRows = hasHeaderRow ? parsedRows.slice(1) : parsedRows;

  const lines = [
    `Structured table extracted from "${input.fileName}".`,
    `Columns (${headers.length}): ${headers.join(' | ')}`,
    `Data rows: ${dataRows.length}`,
  ];

  dataRows.forEach((row, rowIndex) => {
    const parts = headers.flatMap((header, columnIndex) => {
      const value = row[columnIndex] ?? '';
      return value ? [`${header}: ${value}`] : [];
    });

    lines.push(`Row ${rowIndex + 1}: ${parts.length > 0 ? parts.join(' | ') : '[empty]'}`);
  });

  return lines.join('\n');
};
