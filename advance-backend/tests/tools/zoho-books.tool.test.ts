/**
 * Focused tests for the expanded zohoBooks tool.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeCtx } from './tool-test.helpers.ts';
import { createZohoBooksTool } from '../../src/application/tools/families/zoho-books.tool.ts';
import type { ZohoFinanceOps } from '../../src/application/zoho/zoho-finance-ops.ts';
import { mapZohoError } from '../../src/application/zoho/zoho-error.utils.ts';
import { formatAmount, formatDate } from '../../src/application/zoho/zoho-format.utils.ts';
import { normalizeStatus, parseDateFilter } from '../../src/application/zoho/zoho-filter.utils.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';
import {
  ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE,
  ZOHO_BOOKS_ROW_CONTRACT,
} from '../../src/shared/zoho-books-row-contract.ts';
import { assertOpEnumMatchesDocs } from '../support/op-enum.ts';
import { assertLosslessPagingFixture } from './lossless-paging.fixture.ts';

/** What Zoho answers a write with, keyed by the module path being written to. */
const writtenRecords: Record<string, Record<string, unknown>> = {
  invoices:         { invoice: { invoice_id: 'inv-new', invoice_number: 'INV-9', status: 'draft', total: '100.00', balance: '100.00', currency_code: 'INR' } },
  bills:            { bill: { bill_id: 'bill-new', bill_number: 'B-9', status: 'open', total: '70.00', currency_code: 'INR' } },
  expenses:         { expense: { expense_id: 'exp-new', status: 'unbilled', total: '50.00', currency_code: 'INR' } },
  contacts:         { contact: { contact_id: 'con-new', contact_name: 'Acme Ltd' } },
  customerpayments: { payment: { payment_id: 'pay-1', payment_number: 'P-1', amount: '100.00', currency_code: 'INR' } },
};

/** What a single-record GET answers with, keyed by module. */
const fetchedRecords: Record<string, Record<string, unknown>> = {
  invoices: { invoice: { invoice_id: 'inv-1', invoice_number: 'INV-1', status: 'sent', total: '125.50', currency_code: 'USD' } },
  bills:    { bill: { bill_id: 'bill-1', bill_number: 'B-1', status: 'open', total: '120.50', currency_code: 'INR' } },
  contacts: { contact: { contact_id: 'con-1', contact_name: 'Alice' } },
};

const fakeFinanceOps: Partial<ZohoFinanceOps> = {
  buildOverdueReport: async () => ({
    summary: '1 invoice overdue',
    overdueCount: 1,
    totalOverdueAmount: 100,
    buckets: {},
    topCustomers: [],
    csvLink: null,
    invoices: [{ invoice_id: 'inv-1', total: 100, currency_code: 'USD' }],
    generatedAt: '2026-05-10T08:00:00.000Z',
  } as any),
};

function makeBooksClient(captures: {
  listInput?: unknown;
  endpointInput?: unknown;
  allInput?: unknown;
  mutateInput?: any;
  mutations?: any[];
} = {}) {
  return {
    mutate: async (input: any) => {
      captures.mutateInput = input;
      (captures.mutations ??= []).push(input);
      const moduleName = String(input.path).split('/').filter(Boolean)[0] ?? '';
      return {
        organizationId: 'org-1',
        payload: writtenRecords[moduleName] ?? {},
      };
    },
    listRecords: async (input: unknown) => {
      captures.listInput = input;
      return {
        organizationId: 'org-1',
        items: [
          { bill_id: 'bill-1', total: '120.50', currency_code: 'INR', date: '2026-05-01' },
        ],
        hasMore: false,
        page: 1,
      };
    },
    listAllRecords: async (input: unknown) => {
      captures.allInput = input;
      return {
        organizationId: 'org-1',
        items: [
          { bill_id: 'bill-1', total: '120.50', currency_code: 'INR', date: '2026-05-01' },
        ],
        truncated: false,
      };
    },
    getEndpoint: async (input: any) => {
      captures.endpointInput = input;
      // A single-record path answers with that record; anything else keeps the
      // report-style payload the older tests expect.
      const [moduleName, recordId] = String(input.path).split('/').filter(Boolean);
      if (recordId && fetchedRecords[moduleName!]) return fetchedRecords[moduleName!]!;
      return {
        transactions: [
          { transaction_id: 'txn-1', amount: 88, currency_code: 'USD', transaction_date: '2026-05-02' },
        ],
      };
    },
  } as unknown as ZohoBooksPaginatedClient;
}

function makeTool(overrides: {
  booksClient?:  ZohoBooksPaginatedClient;
  financeOps?:   ZohoFinanceOps;
  attachmentSource?: Parameters<typeof createZohoBooksTool>[0]['attachmentSource'];
} = {}) {
  return createZohoBooksTool({
    booksClient:     overrides.booksClient ?? makeBooksClient(),
    financeOps:      overrides.financeOps ?? (fakeFinanceOps as ZohoFinanceOps),
    ...(overrides.attachmentSource ? { attachmentSource: overrides.attachmentSource } : {}),
    inlineThreshold: 25,
    appBaseUrl: 'https://books.zoho.com',
  });
}

describe('zohoBooks expanded permissions', () => {
  it('maps new read, create, and delete operations to the expected action groups', () => {
    const tool = makeTool();

    const read = tool.permissionCheck({ op: 'list_bills' }, makeAllowedPerm('zohoBooks', ['read']));
    assert.equal((read as any).value, 'read');

    const create = tool.permissionCheck({ op: 'record_payment' }, makeAllowedPerm('zohoBooks', ['create']));
    assert.equal((create as any).value, 'create');

    const del = tool.permissionCheck({ op: 'void_invoice' }, makeAllowedPerm('zohoBooks', ['delete']));
    assert.equal((del as any).value, 'delete');
  });

});

describe('zohoBooks expanded execution', () => {
  const ctx = makeCtx('zohoBooks', ['read', 'create', 'delete']);

  it('normalizes date/status filters for list_bills', async () => {
    const captures: { listInput?: any; allInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const result = await tool.execute({
      op: 'list_bills',
      dateFrom: '2026',
      status: 'partially paid',
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.moduleName, 'bills');
    assert.equal(captures.listInput.filters.date_start, '2026-01-01');
    assert.equal(captures.listInput.filters.date_end, '2026-12-31');
    assert.equal(captures.listInput.filters.status, 'partially_paid');
    assert.equal(captures.allInput, undefined);

    const items = (result as any).value.preview.rows as any[];
    assert.equal(items[0].total, '120.50');
    assert.equal(items[0].totalFormatted, '₹120.50');
    assert.equal(items[0].date, '2026-05-01');
  });

  it('allows terminal pagination beyond the former 20-page ceiling', async () => {
    const captures: { listInput?: any } = {};
    const booksClient = {
      ...makeBooksClient(captures),
      listRecords: async (input: any) => {
        captures.listInput = input;
        return {
          organizationId: 'org-1',
          items: [{ expense_id: 'exp-20', total: '10.00', currency_code: 'INR', date: '2026-05-01' }],
          hasMore: true,
          page: input.page,
        };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient });

    const result = await tool.execute({
      op: 'list_expenses',
      page: 20,
      limit: 100,
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.page, 20);
    assert.equal(result.ok && result.value.nextPage, 21);
    assert.equal(result.ok && result.value.preview?.rows[0]?.amount, 10);
    assert.equal(result.ok && result.value.preview?.rows[0]?.amountFormatted, '₹10.00');
    assert.match(tool.parameterDocs, /page \(1-100\)/);
  });

  it('returns 200-row pages only to the trusted local-file audience', async () => {
    const captures: { listInput?: any } = {};
    const booksClient = {
      ...makeBooksClient(captures),
      listRecords: async (input: any) => {
        captures.listInput = input;
        return {
          organizationId: 'org-1',
          items: Array.from({ length: 200 }, (_, index) => ({
            expense_id: `exp-${index + 1}`,
            total: String(index + 1),
            currency_code: 'INR',
            date: '2026-07-01',
          })),
          hasMore: true,
          page: input.page,
        };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient });

    const localResult = await tool.execute(
      { op: 'list_expenses', page: 1, limit: 200 },
      { ...ctx, resultAudience: 'local_file' },
    );
    assert.equal(localResult.ok, true);
    assert.equal(captures.listInput.perPage, 200);
    assert.equal(localResult.ok && localResult.value.preview?.rows.length, 200);

    const chatResult = await tool.execute(
      { op: 'list_expenses', page: 1, limit: 200 },
      ctx,
    );
    assert.equal(chatResult.ok, true);
    assert.equal(captures.listInput.perPage, 25);
    assert.equal(chatResult.ok && chatResult.value.preview?.rows.length, 25);
  });

  it('preserves 0, 1, 10, 100, 200, and multi-page terminal fixtures without gaps', async () => {
    for (const totalRows of [0, 1, 10, 100, 200, 410]) {
      const source = Array.from({ length: totalRows }, (_, index) => ({
        expense_id: `exp-${String(index + 1).padStart(3, '0')}`,
        total: String(index + 1),
        currency_code: 'INR',
        date: '2026-07-01',
      }));
      const calls: Array<{ page?: number; perPage?: number; filters?: Record<string, unknown> }> = [];
      const booksClient = {
        ...makeBooksClient(),
        listRecords: async (input: any) => {
          calls.push(input);
          const page = input.page ?? 1;
          const perPage = input.perPage ?? 25;
          const start = (page - 1) * perPage;
          const items = source.slice(start, start + perPage);
          return {
            organizationId: 'org-1',
            items,
            hasMore: start + items.length < source.length,
            page,
          };
        },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = makeTool({ booksClient });

      const proof = await assertLosslessPagingFixture({
        expectedIds: source.map(row => row.expense_id),
        initialCursor: 1,
        readPage: async page => {
          const result = await tool.execute({
            op: 'list_expenses',
            dateFrom: '2026-04-01',
            dateTo: '2026-07-31',
            page,
            limit: 200,
          }, { ...ctx, resultAudience: 'local_file' });
          assert.equal(result.ok, true);
          if (!result.ok) throw result.error;
          return {
            rows: result.value.preview?.rows ?? [],
            hasMore: result.value.hasMore ?? false,
            ...(result.value.nextPage === undefined
              ? {}
              : { nextCursor: result.value.nextPage }),
          };
        },
        rowId: row => String(row['id']),
      });

      assert.equal(proof.rows.length, totalRows);
      assert.deepEqual(calls.map(call => call.perPage), Array(calls.length).fill(200));
      assert.deepEqual(calls.map(call => call.filters?.['date_start']), Array(calls.length).fill('2026-04-01'));
      assert.deepEqual(calls.map(call => call.filters?.['date_end']), Array(calls.length).fill('2026-07-31'));
      if (totalRows === 410) assert.deepEqual(proof.pageSizes, [200, 200, 10]);
    }
  });

  it('surfaces contact payable/receivable totals in list_contacts preview', async () => {
    const booksClient = {
      listRecords: async (input: { moduleName: string }) => ({
        organizationId: 'org-1',
        items: input.moduleName === 'contacts'
          ? [{
              contact_id: 'con-1',
              contact_name: 'DIAMOND PRINTING PRESS',
              company_name: 'DIAMOND PRINTING PRESS',
              email: 'vendor@example.com',
              phone: '',
              status: 'active',
              currency_code: 'INR',
              outstanding_payable_amount: 195920.6,
              outstanding_receivable_amount: 0,
            }]
          : [],
        hasMore: false,
        page: 1,
      }),
      listAllRecords: async () => ({ organizationId: 'org-1', items: [], truncated: false }),
      getEndpoint: async () => ({ transactions: [] }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient });

    const result = await tool.execute({ op: 'list_contacts', searchQuery: 'Diamond' }, ctx);

    assert.equal(result.ok, true);
    const columns = (result as any).value.preview.columns as string[];
    assert.ok(columns.includes('outstanding_payable_amount'));
    assert.ok(columns.includes('outstanding_receivable_amount'));
    const row = (result as any).value.preview.rows[0];
    assert.equal(row.outstanding_payable_amount, 195920.6);
    assert.equal(row.outstanding_receivable_amount, 0);
  });

  it('passes search text and date filters to search_transactions', async () => {
    const captures: { listInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const result = await tool.execute({
      op: 'search_transactions',
      searchQuery: 'Acme',
      dateFrom: 'Q1 2026',
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.moduleName, 'banktransactions');
    assert.equal(captures.listInput.query, 'Acme');
    assert.equal(captures.listInput.filters.date_start, '2026-01-01');
    assert.equal(captures.listInput.filters.date_end, '2026-03-31');
  });

  // The account was accepted and dropped, so a one-account question quietly
  // read every account in the organisation and reported the result as scoped.
  it('forwards accountId as account_id for bank transactions', async () => {
    const captures: { listInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const result = await tool.execute({
      op: 'list_bank_transactions',
      accountId: '3846597000009355454',
      status: 'uncategorized',
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.moduleName, 'banktransactions');
    assert.equal(captures.listInput.filters.account_id, '3846597000009355454');
    assert.equal(captures.listInput.filters.status, 'uncategorized');
  });

  // Zoho answers this combination with "The account does not exist", which
  // reads as a missing bank account rather than a missing argument.
  it('refuses a bank transaction status filter that names no account', async () => {
    const captures: { listInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    for (const op of ['list_bank_transactions', 'search_transactions']) {
      const result = await tool.execute({
        op,
        status: 'uncategorized',
        ...(op === 'search_transactions' ? { searchQuery: 'ICICI' } : {}),
      }, ctx);

      assert.equal(result.ok, false, `${op} should refuse`);
      assert.match(String((result as any).error.message), /accountId/);
    }
    // Refused before the provider was called, not after a confusing 400.
    assert.equal(captures.listInput, undefined);
  });

  it('still reads bank transactions unscoped when no status filter is asked for', async () => {
    const captures: { listInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const result = await tool.execute({ op: 'list_bank_transactions' }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.filters.status, undefined);
    assert.equal(captures.listInput.filters.account_id, undefined);
  });

  it('forwards invoice search text and requests newest invoice dates first', async () => {
    const captures: { listInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const result = await tool.execute({
      op: 'list_invoices',
      searchQuery: 'FINV/26-27/093',
      limit: 5,
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.moduleName, 'invoices');
    assert.equal(captures.listInput.query, 'FINV/26-27/093');
    assert.equal(captures.listInput.filters.sort_column, 'date');
    assert.equal(captures.listInput.filters.sort_order, 'D');
  });

  it('resolves an exact human invoice number before fetching full detail', async () => {
    const captures: { listInput?: any; fetchedId?: string } = {};
    const booksClient = {
      listRecords: async (input: unknown) => {
        captures.listInput = input;
        return {
          organizationId: 'org-1',
          items: [
            { invoice_id: '1500391000036778001', invoice_number: 'FINV/26-27/093' },
            { invoice_id: '1500391000036778002', invoice_number: 'FINV/26-27/093-copy' },
          ],
          hasMore: false,
          page: 1,
        };
      },
    } as unknown as ZohoBooksPaginatedClient;
    (booksClient as any).getEndpoint = async (input: any) => {
      captures.fetchedId = String(input.path).split('/').filter(Boolean)[1];
      return { invoice: { invoice_id: captures.fetchedId, invoice_number: 'FINV/26-27/093' } };
    };
    const tool = makeTool({ booksClient });

    const result = await tool.execute({
      op: 'get_invoice',
      invoiceId: 'FINV/26-27/093',
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.query, 'FINV/26-27/093');
    assert.equal(captures.listInput.perPage, 200);
    assert.equal(captures.fetchedId, '1500391000036778001');
    assert.equal((result as any).value.data.invoice_number, 'FINV/26-27/093');
  });

  it('does not label payment amounts as INR when Zoho omits currency', async () => {
    const booksClient = {
      listRecords: async () => ({
        organizationId: 'org-1',
        items: [{
          payment_id: 'payment-1',
          payment_number: 'PAY-1',
          customer_name: 'Foreign customer',
          date: '2026-07-01',
          amount: 100,
          bcy_amount: 9_500,
        }],
        hasMore: false,
        page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient });

    const result = await tool.execute({ op: 'list_payments' }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const item = result.value.preview!.rows[0] as any;
    assert.equal(item.currency_code, undefined);
    assert.equal(item.amountFormatted, undefined);
    assert.match(result.value.message ?? '', /currency unavailable/i);
  });

  it('does not exhaust all pages for a small ordinary list', async () => {
    const captures: { listInput?: any; allInput?: any } = {};
    const booksClient = {
      listRecords: async (input: unknown) => {
        captures.listInput = input;
        return {
          organizationId: 'org-1',
          items: Array.from({ length: 25 }, (_, i) => ({
            invoice_id: `inv-${i}`,
            invoice_number: `INV-${i}`,
            total: i + 1,
            currency_code: 'INR',
          })),
          hasMore: true,
          page: 1,
        };
      },
      listAllRecords: async (input: unknown) => {
        captures.allInput = input;
        return { organizationId: 'org-1', items: [], truncated: false };
      },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient });

    const result = await tool.execute({ op: 'list_invoices', limit: 5 }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.page, 1);
    assert.equal(captures.listInput.perPage, 25);
    assert.equal(captures.allInput, undefined);
    if (!result.ok) return;
    assert.equal(result.value.preview?.rows.length, 5);
    assert.equal(result.value.hasMore, true);
    assert.equal(result.value.nextPage, 2);
  });

  it('projects wide list records to documented fields without duplicating rows', async () => {
    const booksClient = {
      listRecords: async () => ({
        organizationId: 'org-1',
        items: [{
          invoice_id: 'inv-1',
          invoice_number: 'INV-1',
          customer_name: 'Customer',
          date: '2026-07-01',
          due_date: '2026-07-31',
          status: 'sent',
          total: 100,
          balance: 50,
          currency_code: 'INR',
          line_items: Array.from({ length: 100 }, (_, i) => ({ name: `item-${i}` })),
          unwanted_blob: 'x'.repeat(20_000),
        }],
        hasMore: false,
        page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient });

    const result = await tool.execute({ op: 'list_invoices' }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const item = result.value.preview!.rows[0] as any;
    assert.equal(item.invoice_number, 'INV-1');
    assert.equal(item.totalFormatted, '₹100.00');
    assert.equal(item.line_items, undefined);
    assert.equal(item.unwanted_blob, undefined);
    assert.equal((result.value.report as any).items, undefined);
    assert.ok(JSON.stringify(result.value).length < 5_000);
  });

  it('returns mapped Zoho error messages from upstream failures', async () => {
    const throwingBooksClient = {
      listRecords: async () => { throw new Error('Zoho Books 400: {"code":4823}'); },
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({ booksClient: throwingBooksClient });

    const result = await tool.execute({ op: 'list_invoices' }, ctx);

    assert.equal(result.ok, false);
    assert.equal((result as any).error.payload.reason, 'upstream_failure');
    assert.match((result as any).error.payload.message, /cannot be modified/);
  });

  it('executes write operations through the paginated client', async () => {
    const captures: { mutations?: any[] } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const sent = await tool.execute({ op: 'send_invoice', invoiceId: 'inv-1', email: 'finance@example.com' }, ctx);
    // `invoices`, not a bare `invoice_id`: Zoho only settles an invoice when the
    // payment names the application. The earlier shape here was the one that
    // stranded ₹59,000 as an unapplied credit in production.
    const payment = await tool.execute({
      op: 'record_payment',
      fields: { customer_id: 'cust-1', amount: 100, invoices: [{ invoice_id: 'inv-1', amount_applied: 100 }] },
    }, ctx);
    const expense = await tool.execute({ op: 'create_expense', fields: { amount: 50 } }, ctx);
    const bill = await tool.execute({ op: 'create_bill', fields: { amount: 70 } }, ctx);
    const voided = await tool.execute({ op: 'void_invoice', invoiceId: 'inv-1' }, ctx);

    assert.equal((sent as any).value.id, 'inv-1');
    assert.equal((payment as any).value.id, 'pay-1');
    assert.equal((expense as any).value.id, 'exp-new');
    assert.equal((bill as any).value.id, 'bill-new');
    assert.equal((voided as any).value.id, 'inv-1');

    // Every one of them is a write, so every one carries the acting member and
    // the exact connection rather than falling back to a company token.
    for (const mutation of captures.mutations ?? []) {
      assert.equal(typeof mutation.userId, 'string');
      assert.equal(mutation.userId.length > 0, true);
    }
  });

  it('keeps explicit exports out of the direct Pi preview path', () => {
    const tool = makeTool();
    assert.match(tool.description, /Do not call this registered Pi tool for a preview first/i);
    assert.match(tool.description, /begin the local workflow and call Zoho through divo-local/i);
    assert.doesNotMatch(`${tool.description}\n${tool.parameterDocs}`, /script mode|scriptArgs|4,000-record/i);
  });

  /*
   * These are facts about what this tool returns, so they belong to this tool.
   * They were asserted on `zoho-books-read-analysis`, which held a second copy
   * of each — and the row contract was a third, since parameterDocs already
   * interpolated the same shared constants.
   */
  it('states its own row shape, ordering, and currency rules', () => {
    const tool = makeTool();
    assert.match(tool.parameterDocs, /returns newest invoice dates first/i);
    assert.match(tool.parameterDocs, /get_invoice accepts a Zoho numeric invoice ID or an exact human invoice number/i);
    assert.match(tool.parameterDocs, /_currency = ISO code or UNKNOWN; never label UNKNOWN as INR/);
    assert.match(tool.parameterDocs, /never produce an original-currency breakdown from UNKNOWN rows/);
    assert.match(tool.parameterDocs, /list_items gives item_id and rate/);
    assert.match(tool.parameterDocs, /never guess a tax rate or tax id/);
    const rowFields = tool.parameterDocs.indexOf('ROW FIELDS');
    assert.ok(rowFields > 0);
    assert.ok(tool.parameterDocs.includes(ZOHO_BOOKS_ROW_CONTRACT));
    assert.ok(tool.parameterDocs.includes(ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE));
  });

  /*
   * `fields` is z.record(z.unknown()), so the serialized schema says nothing
   * about a staged invoice's payload and no other layer states it. Without
   * this the model guesses and learns from a blocking reviewer verdict, one
   * model call later.
   */
  it('states the staged invoice payload the schema cannot', () => {
    const tool = makeTool();
    assert.match(tool.parameterDocs, /stage_invoice fields, at minimum: customer_id/);
    assert.match(tool.parameterDocs, /line_items, each carrying item_id or name, quantity, rate, and tax_id/);
    // Omitting place_of_supply does not block: checkInvoice degrades to the
    // non-blocking gst_direction_unchecked warning, so the one check the
    // staging pipeline exists for silently does not run.
    assert.match(tool.parameterDocs, /Include place_of_supply whenever the draft carries tax/);
  });

  /*
   * This tool is where op drift was actually found: the documented op line had
   * no stage_invoice while the enum did, so the documented and the validated
   * surface disagreed about whether an invoice could be staged at all.
   */
  it('documents exactly the ops its schema validates', () => {
    assertOpEnumMatchesDocs(makeTool());
  });

});

describe('Zoho utility functions', () => {
  it('formats amounts and dates for display', () => {
    assert.equal(formatAmount(123.45, 'USD'), '$123.45');
    assert.equal(formatAmount(7670, 'INR'), '₹7,670.00');
    assert.equal(formatDate('2026-05-10'), 'May 10, 2026');
  });

  it('parses date filters and normalizes statuses', () => {
    assert.deepEqual(parseDateFilter('Q1 2026'), { from: '2026-01-01', to: '2026-03-31' });
    assert.equal(normalizeStatus('Partially Paid'), 'partially_paid');
  });

  it('maps Zoho Books error codes to user-facing messages', () => {
    assert.match(mapZohoError(new Error('Zoho Books 400: {"code":1002}')), /authentication failed/i);
    assert.match(mapZohoError({ response: { data: { code: 4001 } } }), /organization/i);
  });
});
