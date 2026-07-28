import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleZohoList } from '../../src/application/zoho/zoho-list-handler.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

function makeBooksClient(input: {
  firstItems: Array<Record<string, unknown>>;
  hasMore?: boolean;
  allItems?: Array<Record<string, unknown>>;
  truncated?: boolean;
}) {
  return {
    listRecords: async () => ({
      organizationId: 'org-1',
      items: input.firstItems,
      hasMore: input.hasMore ?? false,
      page: 1,
    }),
    listAllRecords: async () => ({
      organizationId: 'org-1',
      items: input.allItems ?? input.firstItems,
      truncated: input.truncated ?? false,
    }),
  } as any;
}

function makeCloudinary(available = true) {
  const uploads: Array<{ fileName: string; count: number; csv: string }> = [];
  return {
    uploads,
    adapter: {
      isAvailable: available,
      uploadCsvBuffer: async (input: { fileName: string; buffer: Buffer }) => {
        const csv = input.buffer.toString('utf8');
        uploads.push({ fileName: input.fileName, count: csv.split('\n').length, csv });
        return {
          publicId: 'temp_exports/co-1/export.csv',
          signedUrl: 'https://cdn.example.com/export.csv',
          expiresAt: '2026-05-11T00:00:00.000Z',
        };
      },
    } as any,
  };
}

const columns = [
  { key: 'invoice_id', header: 'Invoice ID' },
  { key: 'total', header: 'Total' },
  { key: 'currency_code', header: 'Currency' },
];

describe('handleZohoList', () => {
  it('returns small results inline', async () => {
    const cloudinary = makeCloudinary();
    const result = await handleZohoList({
      companyId: 'company-123456',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      csvColumns: columns,
      booksClient: makeBooksClient({ firstItems: [{ invoice_id: 'inv-1', total: 10, currency_code: 'USD' }] }),
      cloudinary: cloudinary.adapter,
      logger: noopLogger,
      summarize: items => `Found ${items.length} invoices.`,
    });

    assert.equal(result.totalCount, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.suggestExport, false);
    assert.equal(cloudinary.uploads.length, 0);
  });

  it('suggests export instead of exhausting broad large lists', async () => {
    const result = await handleZohoList({
      companyId: 'company-123456',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      csvColumns: columns,
      booksClient: makeBooksClient({
        firstItems: Array.from({ length: 30 }, (_, i) => ({ invoice_id: `inv-${i}` })),
        hasMore: true,
      }),
      cloudinary: makeCloudinary().adapter,
      logger: noopLogger,
      summarize: items => `Found ${items.length} invoices.`,
    });

    assert.equal(result.suggestExport, true);
    assert.equal(result.hasMore, true);
    assert.match(result.summary, /top-level exportAll=true/);
    assert.match(result.summary, /Do not fetch pages manually/);
    assert.equal(result.items.length, 25);
  });

  it('does not auto-export an oversized final page', async () => {
    const cloudinary = makeCloudinary();
    const result = await handleZohoList({
      companyId: 'company-123456',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      inlineThreshold: 5,
      csvColumns: columns,
      booksClient: makeBooksClient({
        firstItems: Array.from({ length: 19 }, (_, i) => ({ invoice_id: `inv-${i}` })),
        hasMore: false,
      }),
      cloudinary: cloudinary.adapter,
      logger: noopLogger,
      summarize: items => `Found ${items.length} invoices.`,
    });

    assert.equal(result.items.length, 5);
    assert.equal(result.hasMore, false);
    assert.equal(result.suggestExport, true);
    assert.equal(result.csvLink, undefined);
    assert.equal(cloudinary.uploads.length, 0);
  });

  it('exports full lists when requested', async () => {
    const cloudinary = makeCloudinary();
    const result = await handleZohoList({
      companyId: 'company-123456',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      exportAll: true,
      csvColumns: columns,
      booksClient: makeBooksClient({
        firstItems: Array.from({ length: 25 }, (_, i) => ({ invoice_id: `first-${i}` })),
        hasMore: true,
        allItems: Array.from({ length: 30 }, (_, i) => ({ invoice_id: `inv-${i}`, total: i, currency_code: 'USD' })),
      }),
      cloudinary: cloudinary.adapter,
      logger: noopLogger,
      summarize: items => `Found ${items.length} invoices: $435.00 (USD).`,
    });

    assert.equal(result.totalCount, 30);
    assert.equal(result.items.length, 25);
    assert.equal(result.csvLink, 'https://cdn.example.com/export.csv');
    assert.equal(cloudinary.uploads.length, 1);
    assert.match(cloudinary.uploads[0]!.fileName, /^divo-invoices-/);
    assert.match(cloudinary.uploads[0]!.csv, /\n"Generated by Divo on [^"]+"\s*$/);
  });

  it('exports an explicitly requested small list', async () => {
    const cloudinary = makeCloudinary();
    const result = await handleZohoList({
      companyId: 'company-123456',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      exportAll: true,
      csvColumns: columns,
      booksClient: makeBooksClient({
        firstItems: [{ invoice_id: 'inv-1', total: 10, currency_code: 'USD' }],
        allItems: [{ invoice_id: 'inv-1', total: 10, currency_code: 'USD' }],
      }),
      cloudinary: cloudinary.adapter,
      logger: noopLogger,
      summarize: items => `Found ${items.length} invoices.`,
    });

    assert.equal(result.totalCount, 1);
    assert.equal(result.csvLink, 'https://cdn.example.com/export.csv');
    assert.match(result.summary, /CSV download link/);
    assert.equal(cloudinary.uploads.length, 1);
  });

  it('neutralizes spreadsheet formulas in provider values', async () => {
    const cloudinary = makeCloudinary();
    await handleZohoList({
      companyId: 'company-123456',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      exportAll: true,
      csvColumns: columns,
      booksClient: makeBooksClient({
        firstItems: [{ invoice_id: '=cmd()', total: '+10', currency_code: '@USD' }],
      }),
      cloudinary: cloudinary.adapter,
      logger: noopLogger,
      summarize: items => `Found ${items.length} invoices.`,
    });

    assert.match(cloudinary.uploads[0]?.csv ?? '', /'=cmd\(\),'\+10,'@USD/);
  });

  it('falls back to inline preview when Cloudinary is unavailable', async () => {
    const result = await handleZohoList({
      companyId: 'company-123456',
      moduleName: 'invoices',
      moduleLabel: 'invoices',
      exportAll: true,
      csvColumns: columns,
      booksClient: makeBooksClient({
        firstItems: [],
        allItems: Array.from({ length: 30 }, (_, i) => ({ invoice_id: `inv-${i}` })),
      }),
      cloudinary: makeCloudinary(false).adapter,
      logger: noopLogger,
      summarize: items => `Found ${items.length} invoices.`,
    });

    assert.equal(result.csvLink, undefined);
    assert.match(result.summary, /CSV export is unavailable/);
    assert.equal(result.items.length, 25);
  });
});
