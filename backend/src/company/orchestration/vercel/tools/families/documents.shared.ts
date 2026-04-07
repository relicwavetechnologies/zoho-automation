const inferCurrency = (text: string): string | undefined => {
  if (/₹|rs\.?|inr/i.test(text)) return 'INR';
  if (/\bUSD\b|\$/i.test(text)) return 'USD';
  if (/\bEUR\b|€/i.test(text)) return 'EUR';
  if (/\bGBP\b|£/i.test(text)) return 'GBP';
  return undefined;
};

const parseNumericAmount = (value: string): number | null => {
  const cleaned = value
    .replace(/[^0-9().,\-]/g, '')
    .replace(/,/g, '')
    .trim();
  if (!cleaned) return null;
  const negative = cleaned.startsWith('(') && cleaned.endsWith(')');
  const normalized = negative ? `-${cleaned.slice(1, -1)}` : cleaned;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const detectDateStrings = (text: string): string[] => {
  const matches = text.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 24);
};

const extractFieldByLabels = (text: string, labels: string[]): string | undefined => {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:#-]?\\s*([^\\n]+)`, 'i'));
    const value = match?.[1]?.trim();
    if (value) {
      return value.replace(/\s{2,}/g, ' ');
    }
  }
  return undefined;
};

const extractBestAmount = (text: string, labels: string[]): number | undefined => {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:#-]?\\s*([\\(\\)₹$A-Z\\s0-9,.-]+)`, 'i'));
    const amount = match?.[1] ? parseNumericAmount(match[1]) : null;
    if (amount !== null) {
      return amount;
    }
  }
  return undefined;
};

export const parseInvoiceDocument = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const invoiceNumber =
    extractFieldByLabels(text, [
      'invoice\\s*(?:no|number)',
      'bill\\s*(?:no|number)',
      'ref(?:erence)?\\s*(?:no|number)',
    ]) ?? lines.find((line) => /invoice/i.test(line) && /\d/.test(line));
  const vendorName =
    extractFieldByLabels(text, ['vendor', 'supplier', 'from', 'seller', 'billed\\s+by']) ??
    lines.find(
      (line) =>
        /^[A-Za-z][A-Za-z0-9&.,()\- ]{3,}$/.test(line) && !/invoice|tax|gst|bill to/i.test(line),
    );
  const dueDate = extractFieldByLabels(text, ['due\\s*date', 'payment\\s*due']);
  const invoiceDate =
    extractFieldByLabels(text, ['invoice\\s*date', 'bill\\s*date', 'date']) ??
    detectDateStrings(text)[0];
  const gstin = text.match(/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]Z[A-Z0-9]\b/i)?.[0];
  const subtotal = extractBestAmount(text, ['subtotal', 'taxable\\s*value', 'net\\s*amount']);
  const taxAmount = extractBestAmount(text, ['gst', 'igst', 'cgst', 'sgst', 'tax']);
  const totalAmount =
    extractBestAmount(text, [
      'grand\\s*total',
      'invoice\\s*total',
      'total\\s*amount',
      'amount\\s*due',
      'total',
    ]) ??
    (() => {
      const amounts = Array.from(
        text.matchAll(
          /(?:₹|rs\.?|inr)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))/gi,
        ),
      )
        .map((match) => parseNumericAmount(match[1] ?? ''))
        .filter((value): value is number => value !== null);
      return amounts.length > 0 ? Math.max(...amounts) : undefined;
    })();

  return {
    vendorName,
    invoiceNumber,
    invoiceDate,
    dueDate,
    gstin,
    currency: inferCurrency(text),
    subtotal,
    taxAmount,
    totalAmount,
    candidateDates: detectDateStrings(text),
    lineCount: lines.length,
  };
};

export const parseStatementDocument = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rowRegex =
    /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(.+?)\s+([()\-0-9,]+\.\d{2}|[()\-0-9,]+)\s*$/;
  const rows = lines.flatMap((line) => {
    const match = line.match(rowRegex);
    if (!match) return [];
    const amount = parseNumericAmount(match[3] ?? '');
    return [
      {
        date: match[1],
        description: match[2].replace(/\s{2,}/g, ' ').trim(),
        amount,
        direction: amount !== null && amount < 0 ? 'debit' : 'credit',
      },
    ];
  });

  const closingBalance = extractBestAmount(text, [
    'closing\\s*balance',
    'balance\\s*as\\s*on',
    'available\\s*balance',
  ]);
  const openingBalance = extractBestAmount(text, [
    'opening\\s*balance',
    'balance\\s*brought\\s*forward',
  ]);
  const totalCredits = rows
    .filter((row) => typeof row.amount === 'number' && row.amount >= 0)
    .reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const totalDebits = rows
    .filter((row) => typeof row.amount === 'number' && row.amount < 0)
    .reduce((sum, row) => sum + Math.abs(row.amount ?? 0), 0);

  return {
    statementType: /bank/i.test(text)
      ? 'bank'
      : /ledger|account/i.test(text)
        ? 'account'
        : 'generic',
    accountName: extractFieldByLabels(text, [
      'account\\s*name',
      'statement\\s*for',
      'customer\\s*name',
    ]),
    accountNumber: extractFieldByLabels(text, [
      'account\\s*(?:no|number)',
      'a\\/c\\s*(?:no|number)',
    ]),
    dateRange: {
      from: extractFieldByLabels(text, ['from', 'period\\s*from']) ?? detectDateStrings(text)[0],
      to: extractFieldByLabels(text, ['to', 'period\\s*to']) ?? detectDateStrings(text)[1],
    },
    currency: inferCurrency(text),
    openingBalance,
    closingBalance,
    transactionCount: rows.length,
    totals: {
      credits: totalCredits || undefined,
      debits: totalDebits || undefined,
    },
    rows: rows.slice(0, 200),
  };
};
