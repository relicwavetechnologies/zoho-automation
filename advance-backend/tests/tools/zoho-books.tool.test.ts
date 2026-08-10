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
import { arrayToCsv } from '../../src/application/tools/shared/sandbox-runner.ts';
import { asToolId } from '../../src/shared/ids.ts';

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
  exportCandidates?: Parameters<typeof createZohoBooksTool>[0]['exportCandidates'];
  attachmentSource?: Parameters<typeof createZohoBooksTool>[0]['attachmentSource'];
} = {}) {
  return createZohoBooksTool({
    booksClient:     overrides.booksClient ?? makeBooksClient(),
    financeOps:      overrides.financeOps ?? (fakeFinanceOps as ZohoFinanceOps),
    ...(overrides.exportCandidates ? { exportCandidates: overrides.exportCandidates } : {}),
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
    assert.match(tool.parameterDocs, /page \(1-100\)/);
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
    const item = result.value.preview!.rows[0] as any;
    assert.equal(item.invoice_number, 'INV-1');
    assert.equal(item.totalFormatted, '₹100.00');
    assert.equal(item.line_items, undefined);
    assert.equal(item.unwanted_blob, undefined);
    assert.equal((result.value.report as any).items, undefined);
    assert.ok(JSON.stringify(result.value).length < 5_000);
  });

  it('returns one persisted opaque export candidate for a default list overflow without queueing', async () => {
    let candidatePayload: any;
    const booksClient = {
      listRecords: async () => ({
        organizationId: 'org-1',
        items: Array.from({ length: 25 }, (_, index) => ({
          invoice_id: `inv-${index}`,
          invoice_number: `INV-${index}`,
          total: index + 1,
          currency_code: 'INR',
        })),
        hasMore: true,
        page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    const tool = makeTool({
      booksClient,
      exportCandidates: {
        publishCandidate: async (input) => {
          candidatePayload = input;
          return {
            candidateId: '11111111-1111-4111-8111-111111111111',
            expiresAt: new Date('2026-08-03T00:00:00.000Z'),
          };
        },
      },
    });
    const candidateCtx = makeCtx('zohoBooks', ['read'], {
      chatId: 'oc_test',
      replyToMessageId: 'om_thread_root',
      replyInThread: true,
      requestId: 'om_preview',
    });
    candidateCtx.perm.allowedToolIds.add(asToolId('dataExport'));
    candidateCtx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute({
      op: 'list_invoices',
      connectionId: '11111111-1111-4111-8111-111111111111',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      status: 'partially paid',
    }, candidateCtx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview?.rows.length, 25);
    assert.equal(result.value.preview?.coverage.kind, 'truncated');
    assert.equal(result.value.exportCandidate?.candidateId, '11111111-1111-4111-8111-111111111111');
    assert.match(result.value.message ?? '', /Showing 25 invoices/);
    assert.equal((result.value.report as any).returnedCount, 25);
    assert.equal((result.value.report as any).totalCount, undefined);
    assert.equal(result.value.data, undefined);
    assert.equal(candidatePayload.source.kind, 'zoho_books');
    assert.equal(candidatePayload.source.module, 'invoices');
    assert.equal(candidatePayload.source.connectionId, '11111111-1111-4111-8111-111111111111');
    assert.deepEqual(candidatePayload.source.filters, {
      date_start: '2026-07-01',
      date_end: '2026-07-31',
      status: 'partially_paid',
    });
    assert.equal(candidatePayload.replyToMessageId, 'om_thread_root');
    assert.equal(candidatePayload.replyInThread, true);
    assert.equal('rows' in candidatePayload, false);
  });

  it('does not create an export candidate when any candidate guard is missing', async () => {
    const booksClient = {
      listRecords: async () => ({
        organizationId: 'org-1',
        items: Array.from({ length: 25 }, (_, index) => ({
          invoice_id: `inv-${index}`,
          invoice_number: `INV-${index}`,
          customer_email: 'member@example.com',
          total: index + 1,
          currency_code: 'INR',
        })),
        hasMore: true,
        page: 1,
      }),
    } as unknown as ZohoBooksPaginatedClient;
    let candidateCalls = 0;
    const exportCandidates = {
      publishCandidate: async () => {
        candidateCalls += 1;
        return { candidateId: '11111111-1111-4111-8111-111111111111', expiresAt: new Date() };
      },
    };
    const cases = [
      {
        name: 'explicit limit',
        args: { limit: 5 },
        chatId: 'oc_test',
        allowExport: true,
        candidatesEnabled: true,
      },
      {
        name: 'personalized scope',
        args: {},
        chatId: 'oc_test',
        allowExport: true,
        candidatesEnabled: true,
        personalized: true,
      },
      {
        name: 'missing dataExport permission',
        args: {},
        chatId: 'oc_test',
        allowExport: false,
        candidatesEnabled: true,
      },
      {
        name: 'missing Lark chat',
        args: {},
        allowExport: true,
        candidatesEnabled: true,
      },
      {
        name: 'missing candidate service',
        args: {},
        chatId: 'oc_test',
        allowExport: true,
        candidatesEnabled: false,
      },
    ] as const;

    for (const testCase of cases) {
      const before = candidateCalls;
      const tool = makeTool({
        booksClient,
        ...(testCase.candidatesEnabled ? { exportCandidates } : {}),
      });
      const guardedCtx = makeCtx('zohoBooks', ['read'], {
        ...(testCase.chatId ? { chatId: testCase.chatId } : {}),
        requestId: `om_${testCase.name}`,
        ...(testCase.personalized ? { requesterEmail: 'member@example.com' } : {}),
      });
      if (testCase.allowExport) {
        guardedCtx.perm.allowedToolIds.add(asToolId('dataExport'));
        guardedCtx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));
      }
      if (testCase.personalized) {
        (guardedCtx.perm as any).department = {
          id: 'dept-1',
          name: 'Finance',
          roleSlug: 'MEMBER',
          zohoReadScope: 'personalized',
        };
      }

      const result = await tool.execute({
        op: 'list_invoices',
        connectionId: '11111111-1111-4111-8111-111111111111',
        ...testCase.args,
      }, guardedCtx);

      assert.equal(result.ok, true, testCase.name);
      assert.equal(result.ok && result.value.exportCandidate, undefined, testCase.name);
      assert.equal(candidateCalls, before, testCase.name);
    }
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

  it('publishes every list operation through the export candidate contract when exportAll=true', async () => {
    const candidates: any[] = [];
    const tool = createZohoBooksTool({
      booksClient: makeBooksClient(),
      financeOps: fakeFinanceOps as ZohoFinanceOps,
      exportCandidates: {
        publishCandidate: async (payload) => {
          candidates.push(payload);
          return {
            candidateId: `11111111-1111-4111-8111-${String(candidates.length).padStart(12, '0')}`,
            expiresAt: new Date('2026-08-03T00:00:00.000Z'),
          };
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
      assert.match((result as any).value.exportCandidate.candidateId, /^11111111-1111-4111-8111-/);
      assert.match((result as any).value.message, /export candidate is ready/i);
    }

    assert.deepEqual(candidates.map(job => job.source.module), [
      'invoices',
      'bills',
      'customerpayments',
      'expenses',
      'contacts',
      'banktransactions',
      'banktransactions',
    ]);
    assert.ok(candidates.every(job => job.source.kind === 'zoho_books'));
    assert.ok(candidates.every(job => job.destination.format === 'auto'));
  });

  // exportAll returns before the per-op switch, so the guards on the individual
  // bank-transaction cases never see it. This candidate path must still refuse
  // a replay recipe the provider rejects.
  it('refuses an exportAll bank transaction recipe the provider would reject', async () => {
    let published = 0;
    const tool = makeTool({
      exportCandidates: {
        publishCandidate: async () => {
          published += 1;
          return { candidateId: '11111111-1111-4111-8111-111111111111', expiresAt: new Date() };
        },
      } as any,
    });
    const ctx = makeCtx('zohoBooks', ['read'], { chatId: 'oc_test', requestId: 'om_export_all' });
    ctx.perm.allowedToolIds.add(asToolId('dataExport'));
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute({
      op: 'list_bank_transactions',
      exportAll: true,
      status: 'uncategorized',
      connectionId: '11111111-1111-4111-8111-111111111111',
    }, ctx);

    assert.equal(result.ok, false);
    assert.match(String((result as any).error.message), /accountId/);
    assert.equal(published, 0, 'no candidate may be written for a recipe that cannot run');
  });

  it('publishes an exportAll bank transaction candidate once the account is named', async () => {
    const candidates: any[] = [];
    const tool = makeTool({
      exportCandidates: {
        publishCandidate: async (payload: any) => {
          candidates.push(payload);
          return { candidateId: '11111111-1111-4111-8111-111111111111', expiresAt: new Date() };
        },
      } as any,
    });
    const ctx = makeCtx('zohoBooks', ['read'], { chatId: 'oc_test', requestId: 'om_export_all_ok' });
    ctx.perm.allowedToolIds.add(asToolId('dataExport'));
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tool.execute({
      op: 'list_bank_transactions',
      exportAll: true,
      status: 'uncategorized',
      accountId: '3846597000009355454',
      connectionId: '11111111-1111-4111-8111-111111111111',
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].source.filters.account_id, '3846597000009355454');
    assert.equal(candidates[0].source.filters.status, 'uncategorized');
  });

  it('keeps Google destination selection out of the Zoho Books tool schema', () => {
    const tool = makeTool();
    assert.equal(tool.argsSchema.safeParse({
      op: 'list_invoices' as const,
      connectionId: '11111111-1111-4111-8111-111111111111',
      exportAll: true,
      destinationConnectionId: '22222222-2222-4222-8222-222222222222',
    }).success, false);
  });

  it('keeps explicit exports out of the direct Pi preview path', () => {
    const tool = makeTool();
    assert.match(tool.description, /Do not call this registered Pi tool for a preview first/i);
    assert.match(tool.description, /begin the local workflow and call Zoho through divo-local/i);
    assert.match(tool.description, /Script mode is not an export or transfer contract/i);
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
