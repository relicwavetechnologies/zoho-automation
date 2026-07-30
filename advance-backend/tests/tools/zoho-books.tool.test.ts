/**
 * Focused tests for the expanded zohoBooks tool.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeCtx } from './tool-test.helpers.ts';
import { createZohoBooksTool, type ZohoBooksClientPort } from '../../src/application/tools/families/zoho-books.tool.ts';
import type { ZohoFinanceOps } from '../../src/application/zoho/zoho-finance-ops.ts';
import { mapZohoError } from '../../src/application/zoho/zoho-error.utils.ts';
import { formatAmount, formatDate } from '../../src/application/zoho/zoho-format.utils.ts';
import { normalizeStatus, parseDateFilter } from '../../src/application/zoho/zoho-filter.utils.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';
import { arrayToCsv } from '../../src/application/tools/shared/sandbox-runner.ts';
import { asToolId } from '../../src/shared/ids.ts';

const fakeSimpleClient: ZohoBooksClientPort = {
  listInvoices:  async () => [{ invoice_id: 'inv-1', total: 100, currency_code: 'USD', date: '2026-05-10' }],
  getInvoice:    async () => ({ invoice_id: 'inv-1', total: '125.50', currency_code: 'USD' }),
  createInvoice: async () => ({ invoiceId: 'inv-new' }),
  listContacts:  async () => [{ contact_id: 'con-1', contact_name: 'Alice' }],
  getContact:    async () => ({ contact_id: 'con-1', contact_name: 'Alice' }),
  listExpenses:  async () => [{ expense_id: 'exp-1', amount: 50, currency_code: 'USD' }],
  sendInvoice:   async invoiceId => ({ invoiceId }),
  recordPayment: async () => ({ paymentId: 'pay-1' }),
  createExpense: async () => ({ expenseId: 'exp-new' }),
  createBill:    async () => ({ billId: 'bill-new' }),
  voidInvoice:   async invoiceId => ({ invoiceId }),
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
} = {}) {
  return {
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
    getEndpoint: async (input: unknown) => {
      captures.endpointInput = input;
      return {
        transactions: [
          { transaction_id: 'txn-1', amount: 88, currency_code: 'USD', transaction_date: '2026-05-02' },
        ],
      };
    },
  } as unknown as ZohoBooksPaginatedClient;
}

function makeTool(overrides: {
  simpleClient?: ZohoBooksClientPort | null;
  booksClient?:  ZohoBooksPaginatedClient;
  financeOps?:   ZohoFinanceOps;
} = {}) {
  return createZohoBooksTool({
    getClient:       async () => overrides.simpleClient ?? fakeSimpleClient,
    booksClient:     overrides.booksClient ?? makeBooksClient(),
    financeOps:      overrides.financeOps ?? (fakeFinanceOps as ZohoFinanceOps),
    inlineThreshold: 25,
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

  it('requires dataExport:create for exportAll', () => {
    const tool = makeTool();
    const denied = tool.permissionCheck(
      { op: 'list_invoices', exportAll: true },
      makeAllowedPerm('zohoBooks', ['read']),
    );
    const allowedPerm = makeAllowedPerm('zohoBooks', ['read']);
    allowedPerm.allowedToolIds.add(asToolId('dataExport'));
    allowedPerm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));
    const allowed = tool.permissionCheck(
      { op: 'list_invoices', exportAll: true },
      allowedPerm,
    );

    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.error.payload.toolId, 'dataExport');
    assert.equal(allowed.ok, true);
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

    const items = (result as any).value.data.items as any[];
    assert.equal(items[0].total, '120.50');
    assert.equal(items[0].totalFormatted, '₹120.50');
    assert.equal(items[0].date, '2026-05-01');
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
    const simpleClient = {
      ...fakeSimpleClient,
      getInvoice: async (invoiceId: string) => {
        captures.fetchedId = invoiceId;
        return { invoice_id: invoiceId, invoice_number: 'FINV/26-27/093' };
      },
    };
    const tool = makeTool({ booksClient, simpleClient });

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
    const item = (result.value.data as any).items[0];
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
    assert.equal((result.value.data as any).items.length, 5);
    assert.equal(result.value.suggestExport, false);
    assert.doesNotMatch(result.value.message ?? '', /exportAll/);
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
    const item = (result.value.data as any).items[0];
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

  it('executes new write operations through the simple client', async () => {
    const tool = makeTool();

    const sent = await tool.execute({ op: 'send_invoice', invoiceId: 'inv-1', email: 'finance@example.com' }, ctx);
    const payment = await tool.execute({ op: 'record_payment', fields: { invoice_id: 'inv-1', amount: 100 } }, ctx);
    const expense = await tool.execute({ op: 'create_expense', fields: { amount: 50 } }, ctx);
    const bill = await tool.execute({ op: 'create_bill', fields: { amount: 70 } }, ctx);
    const voided = await tool.execute({ op: 'void_invoice', invoiceId: 'inv-1' }, ctx);

    assert.equal((sent as any).value.id, 'inv-1');
    assert.equal((payment as any).value.id, 'pay-1');
    assert.equal((expense as any).value.id, 'exp-new');
    assert.equal((bill as any).value.id, 'bill-new');
    assert.equal((voided as any).value.id, 'inv-1');
  });

  it('exports every list operation through the tool contract when exportAll=true', async () => {
    const jobs: any[] = [];
    const tool = createZohoBooksTool({
      getClient: async () => fakeSimpleClient,
      booksClient: makeBooksClient(),
      financeOps: fakeFinanceOps as ZohoFinanceOps,
      exportQueue: {
        enqueue: async (payload) => {
          jobs.push(payload);
          return `dtx-${jobs.length}`;
        },
      },
      inlineThreshold: 25,
    });

    const ops = [
      { op: 'list_invoices' as const },
      { op: 'list_bills' as const },
      { op: 'list_payments' as const },
      { op: 'list_expenses' as const },
      { op: 'list_contacts' as const },
      { op: 'list_bank_transactions' as const },
      { op: 'search_transactions' as const, searchQuery: 'Acme' },
    ];

    for (const args of ops) {
      const ctx = makeCtx('zohoBooks', ['read'], {
        chatId: 'oc_test',
        requestId: `om_test_${args.op}`,
      });
      ctx.perm.allowedToolIds.add(asToolId('dataExport'));
      ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));
      const result = await tool.execute({
        ...args,
        connectionId: '11111111-1111-4111-8111-111111111111',
        exportAll: true,
      }, ctx);
      assert.equal(result.ok, true);
      assert.equal((result as any).value.exportQueued, true);
      assert.match((result as any).value.message, /5,000-row cap/i);
      assert.match((result as any).value.message, /not be described as complete/i);
    }

    assert.deepEqual(jobs.map(job => job.source.module), [
      'invoices',
      'bills',
      'customerpayments',
      'expenses',
      'contacts',
      'banktransactions',
      'banktransactions',
    ]);
    assert.ok(jobs.every(job => job.source.kind === 'zoho_books'));
    assert.ok(jobs.every(job => job.destination.format === 'auto'));
  });

  it('bounds script results inline and leaves complete artifacts to dataExport', async () => {
    const booksClient = {
      listAllRecords: async () => ({
        organizationId: 'org-1',
        items: Array.from({ length: 30 }, (_, i) => ({
          invoice_id: `inv-${i}`,
          invoice_number: `INV-${i}`,
          customer_name: `Customer ${i}`,
          total: i + 1,
          currency_code: 'INR',
        })),
        truncated: false,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = createZohoBooksTool({
      getClient: async () => fakeSimpleClient,
      booksClient,
      financeOps: fakeFinanceOps as ZohoFinanceOps,
    });

    const result = await tool.execute({
      op: 'list_invoices',
      script: 'return data',
    }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.value.data as unknown[]).length, 10);
    assert.match(result.value.message ?? '', /Showing first 10 inline/i);
    assert.equal(result.value.csvLink, undefined);
  });
});

describe('Zoho utility functions', () => {
  it('neutralizes spreadsheet formulas in script-generated CSV cells', () => {
    const csv = arrayToCsv(
      ['invoice_id', 'customer_name', 'total', 'status'],
      [{ invoice_id: '=cmd()', customer_name: '+SUM(A1)', total: '-10', status: '@paid' }],
    ).toString('utf8');
    assert.match(csv, /'=cmd\(\),'\+SUM\(A1\),'-10,'@paid/);
  });

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
