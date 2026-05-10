/**
 * Focused tests for the expanded zohoBooks tool.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeCtx } from './tool-test.helpers.ts';
import { createZohoBooksTool, type ZohoBooksClientPort } from '../../src/application/orchestration/tools/families/zoho-books.tool.ts';
import type { ZohoFinanceOps } from '../../src/application/zoho/zoho-finance-ops.ts';
import { mapZohoError } from '../../src/application/zoho/zoho-error.utils.ts';
import { formatAmount, formatDate } from '../../src/application/zoho/zoho-format.utils.ts';
import { normalizeStatus, parseDateFilter } from '../../src/application/zoho/zoho-filter.utils.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';

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
    getClient:   async () => overrides.simpleClient ?? fakeSimpleClient,
    booksClient: overrides.booksClient ?? makeBooksClient(),
    financeOps:  overrides.financeOps ?? (fakeFinanceOps as ZohoFinanceOps),
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

  it('normalizes date/status filters and formats amount/date fields for list_bills', async () => {
    const captures: { listInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const result = await tool.execute({
      op: 'list_bills',
      dateFrom: '2026',
      status: 'partially paid',
      limit: 10,
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.listInput.moduleName, 'bills');
    assert.equal(captures.listInput.filters.from_date, '2026-01-01');
    assert.equal(captures.listInput.filters.to_date, '2026-12-31');
    assert.equal(captures.listInput.filters.status, 'partially_paid');
    assert.equal(captures.listInput.perPage, 10);

    const item = ((result as any).value.data.items as any[])[0];
    assert.equal(item.totalFormatted, '\u20b9120.50');
    assert.equal(item.dateFormatted, 'May 1, 2026');
  });

  it('passes search text and date filters to search_transactions', async () => {
    const captures: { endpointInput?: any } = {};
    const tool = makeTool({ booksClient: makeBooksClient(captures) });

    const result = await tool.execute({
      op: 'search_transactions',
      searchQuery: 'Acme',
      dateFrom: 'Q1 2026',
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(captures.endpointInput.path, '/search');
    assert.equal(captures.endpointInput.params.search_text, 'Acme');
    assert.equal(captures.endpointInput.params.from_date, '2026-01-01');
    assert.equal(captures.endpointInput.params.to_date, '2026-03-31');
  });

  it('returns mapped Zoho error messages from upstream failures', async () => {
    const throwingClient: ZohoBooksClientPort = {
      ...fakeSimpleClient,
      listInvoices: async () => { throw new Error('Zoho Books 400: {"code":4823}'); },
    };
    const tool = makeTool({ simpleClient: throwingClient });

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
});

describe('Zoho utility functions', () => {
  it('formats amounts and dates for display', () => {
    assert.equal(formatAmount(12345, 'USD'), '$123.45');
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
