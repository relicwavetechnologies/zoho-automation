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
  const uploads: Array<{ fileName: string; count: number }> = [];
  return {
    uploads,
    adapter: {
      isAvailable: available,
      uploadCsvBuffer: async (input: { fileName: string; buffer: Buffer }) => {
        uploads.push({ fileName: input.fileName, count: input.buffer.toString('utf8').split('\n').length });
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
    assert.match(result.summary, /export all/i);
    assert.equal(result.items.length, 25);
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
