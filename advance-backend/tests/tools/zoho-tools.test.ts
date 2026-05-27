/**
 * Unit tests for Zoho tool families: CRM and Books.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeDeniedPerm, makeCtx } from './tool-test.helpers.ts';

import { createZohoCrmTool }   from '../../src/application/orchestration/tools/families/zoho-crm.tool.ts';
import { createZohoBooksTool } from '../../src/application/orchestration/tools/families/zoho-books.tool.ts';
import type { ZohoFinanceOps } from '../../src/application/zoho/zoho-finance-ops.ts';
import type { ZohoCrmOps } from '../../src/application/zoho/zoho-crm-ops.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';
import type { ZohoCrmPaginatedClient } from '../../src/infrastructure/zoho/zoho-crm-paginated.client.ts';

// ─── zoho-crm ─────────────────────────────────────────────────────────────────

describe('zohoCrm tool', () => {
  const fakeCrmClient = {
    searchRecords: async () => [{ id: 'lead-1', name: 'Alice' }],
    getRecord:     async () => ({ id: 'lead-1', name: 'Alice' }),
    createRecord:  async () => ({ recordId: 'lead-new' }),
    updateRecord:  async () => {},
    deleteRecord:  async () => {},
  };

  const fakePaginatedCrmClient = {
    listRecords:   async () => ({ items: [{ id: 'lead-1', Last_Name: 'Alice' }], hasMore: false, page: 1 }),
    listAllRecords: async () => ({ items: [{ id: 'lead-1', Last_Name: 'Alice' }], truncated: false }),
    searchRecords: async () => ({ items: [{ id: 'lead-1', Last_Name: 'Alice' }], hasMore: false, page: 1 }),
    searchByText:  async () => ({ items: [{ id: 'lead-1', Last_Name: 'Alice' }], hasMore: false, page: 1 }),
    getRecord:     async () => ({ id: 'lead-1', Last_Name: 'Alice' }),
    createRecord:  async () => ({ id: 'lead-new', data: {} }),
    updateRecord:  async () => {},
    deleteRecord:  async () => {},
  } as unknown as ZohoCrmPaginatedClient;

  const fakeCrmOps = {
    buildPipelineSummary: async () => ({ summary: '3 deals', totalDeals: 3, totalPipelineValue: 100000, currency: 'INR', stages: [], inlineDeals: [], sourceTruncated: false }),
    buildLeadReport:      async () => ({ summary: '5 leads', totalLeads: 5, sources: [], statusBreakdown: {}, inlineLeads: [], sourceTruncated: false }),
    buildDealForecast:    async () => ({ summary: '2 deals closing', totalDeals: 2, totalAmount: 50000, currency: 'INR', byStage: [], inlineDeals: [], sourceTruncated: false }),
  } as unknown as ZohoCrmOps;

  const fakeCloudinary = { isAvailable: false, uploadCsvBuffer: async () => null } as any;

  const noClient  = async () => null;
  const yesClient = async () => fakeCrmClient;

  const makeCrmTool = (getClient = yesClient as typeof noClient | typeof yesClient) =>
    createZohoCrmTool({
      getClient,
      crmClient:  fakePaginatedCrmClient,
      crmOps:     fakeCrmOps,
      cloudinary: fakeCloudinary,
    });

  describe('permissionCheck', () => {
    it('denies when not in allowedActionsByTool', () => {
      const tool = makeCrmTool();
      const r = tool.permissionCheck({ op: 'search' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });

    it('returns "read" for op=search', () => {
      const tool = makeCrmTool();
      const r = tool.permissionCheck({ op: 'search' }, makeAllowedPerm('zohoCrm', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "read" for op=get', () => {
      const tool = makeCrmTool();
      const r = tool.permissionCheck({ op: 'get' }, makeAllowedPerm('zohoCrm', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "create" for op=create', () => {
      const tool = makeCrmTool();
      const r = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('zohoCrm', ['create']));
      assert.equal((r as any).value, 'create');
    });

    it('returns "update" for op=update', () => {
      const tool = makeCrmTool();
      const r = tool.permissionCheck({ op: 'update' }, makeAllowedPerm('zohoCrm', ['update']));
      assert.equal((r as any).value, 'update');
    });

    it('returns "delete" for op=delete', () => {
      const tool = makeCrmTool();
      const r = tool.permissionCheck({ op: 'delete' }, makeAllowedPerm('zohoCrm', ['delete']));
      assert.equal((r as any).value, 'delete');
    });

    it('denies create when only read allowed', () => {
      const tool = makeCrmTool();
      const r = tool.permissionCheck({ op: 'create' }, makeAllowedPerm('zohoCrm', ['read']));
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('zohoCrm', ['read', 'create', 'update', 'delete']);

    it('list: bad_args when module missing', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'list' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('list: ok with records', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'list', module: 'Leads' }, ctx);
      assert.equal(r.ok, true);
    });

    it('search: ok with criteria', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'search', module: 'Leads', criteria: '(Last_Name:contains:Alice)' }, ctx);
      assert.equal(r.ok, true);
    });

    it('search_text: ok with query', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'search_text', module: 'Leads', query: 'Alice' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get: bad_args when recordId missing', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'get', module: 'Leads' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'bad_args');
    });

    it('get: ok with record', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'get', recordId: 'lead-1', module: 'Leads' }, ctx);
      assert.equal(r.ok, true);
    });

    it('create: ok with recordId', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'create', module: 'Leads', fields: { Last_Name: 'Smith' } }, ctx);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.recordId, 'lead-new');
    });

    it('create: bad_args when fields missing', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'create', module: 'Leads' }, ctx);
      assert.equal(r.ok, false);
    });

    it('update: bad_args when recordId missing', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'update', module: 'Leads', fields: { Last_Name: 'Jones' } }, ctx);
      assert.equal(r.ok, false);
    });

    it('update: ok when recordId and fields present', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'update', recordId: 'lead-1', module: 'Leads', fields: { Last_Name: 'Jones' } }, ctx);
      assert.equal(r.ok, true);
    });

    it('delete: bad_args when recordId missing', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'delete', module: 'Leads' }, ctx);
      assert.equal(r.ok, false);
    });

    it('delete: ok when recordId present', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'delete', recordId: 'lead-1', module: 'Leads' }, ctx);
      assert.equal(r.ok, true);
    });

    it('infra throws → upstream_failure', async () => {
      const throwingPaginated = {
        ...fakePaginatedCrmClient,
        searchRecords: async () => { throw new Error('err'); },
      } as unknown as ZohoCrmPaginatedClient;
      const tool = createZohoCrmTool({
        getClient: yesClient,
        crmClient: throwingPaginated,
        crmOps: fakeCrmOps,
        cloudinary: fakeCloudinary,
      });
      const r = await tool.execute({ op: 'search', module: 'Leads', criteria: '(Last_Name:equals:x)' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });

    it('build_pipeline_summary: ok', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'build_pipeline_summary' }, ctx);
      assert.equal(r.ok, true);
      assert.ok((r as any).value.report);
    });

    it('build_lead_report: ok', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'build_lead_report' }, ctx);
      assert.equal(r.ok, true);
      assert.ok((r as any).value.report);
    });

    it('build_deal_forecast: ok', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'build_deal_forecast', closingFrom: 'this quarter' }, ctx);
      assert.equal(r.ok, true);
      assert.ok((r as any).value.report);
    });
  });
});

// ─── zoho-books ───────────────────────────────────────────────────────────────

describe('zohoBooks tool', () => {
  const fakeBooksClient = {
    listInvoices:  async () => [{ invoiceId: 'inv-1', total: 100 }],
    getInvoice:    async () => ({ invoiceId: 'inv-1', total: 100 }),
    createInvoice: async () => ({ invoiceId: 'inv-new' }),
    listContacts:  async () => [{ contactId: 'con-1', name: 'Alice' }],
    getContact:    async () => ({ contactId: 'con-1', name: 'Alice' }),
    listExpenses:  async () => [{ expenseId: 'exp-1', amount: 50 }],
  };

  const fakeFinanceOps: Partial<ZohoFinanceOps> = {
    buildOverdueReport: async () => ({
      summary: '2 invoices overdue',
      overdueCount: 2,
      totalOverdueAmount: 1500,
      buckets: {},
      topCustomers: [],
      csvLink: null,
      invoices: [],
      generatedAt: new Date().toISOString(),
    } as any),
  };

  const fakePaginatedBooksClient = {
    listRecords: async (input: { moduleName: string }) => ({
      organizationId: 'org-1',
      items: input.moduleName === 'contacts'
        ? [{ contact_id: 'con-1', contact_name: 'Alice' }]
        : input.moduleName === 'expenses'
          ? [{ expense_id: 'exp-1', amount: 50 }]
          : [{ invoice_id: 'inv-1', total: 100 }],
      hasMore: false,
      page: 1,
    }),
    listAllRecords: async () => ({
      organizationId: 'org-1',
      items: [{ invoice_id: 'inv-1', total: 100 }],
      truncated: false,
    }),
  } as unknown as ZohoBooksPaginatedClient;

  const makeBooksTool = (getClient: typeof noClient | typeof yesClient, financeOps = fakeFinanceOps as ZohoFinanceOps) =>
    createZohoBooksTool({
      getClient,
      financeOps,
      booksClient: fakePaginatedBooksClient,
      cloudinary: { isAvailable: false, uploadCsvBuffer: async () => null } as any,
    });

  const noClient  = async () => null;
  const yesClient = async () => fakeBooksClient;

  describe('permissionCheck', () => {
    it('returns "read" for op=list_invoices', () => {
      const tool = makeBooksTool(noClient);
      const r = tool.permissionCheck({ op: 'list_invoices' }, makeAllowedPerm('zohoBooks', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "create" for op=create_invoice', () => {
      const tool = makeBooksTool(noClient);
      const r = tool.permissionCheck({ op: 'create_invoice' }, makeAllowedPerm('zohoBooks', ['create']));
      assert.equal((r as any).value, 'create');
    });

    it('denies when not in allowedActionsByTool', () => {
      const tool = makeBooksTool(noClient);
      const r = tool.permissionCheck({ op: 'list_invoices' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });

    it('denies create when only read allowed', () => {
      const tool = makeBooksTool(noClient);
      const r = tool.permissionCheck({ op: 'create_invoice' }, makeAllowedPerm('zohoBooks', ['read']));
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('zohoBooks', ['read', 'create']);

    it('get_invoice: no client → unrecoverable', async () => {
      const tool = makeBooksTool(noClient);
      const r = await tool.execute({ op: 'get_invoice', invoiceId: 'inv-1' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'unrecoverable');
    });

    it('list_invoices: ok with invoices', async () => {
      const tool = makeBooksTool(yesClient);
      const r = await tool.execute({ op: 'list_invoices' }, ctx);
      assert.equal(r.ok, true);
    });

    it('get_invoice: ok with invoice', async () => {
      const tool = makeBooksTool(yesClient);
      const r = await tool.execute({ op: 'get_invoice', invoiceId: 'inv-1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('list_contacts: ok with contacts', async () => {
      const tool = makeBooksTool(yesClient);
      const r = await tool.execute({ op: 'list_contacts' }, ctx);
      assert.equal(r.ok, true);
    });

    it('list_expenses: ok with expenses', async () => {
      const tool = makeBooksTool(yesClient);
      const r = await tool.execute({ op: 'list_expenses' }, ctx);
      assert.equal(r.ok, true);
    });

    it('build_overdue_report: ok using financeOps (bypasses client)', async () => {
      const tool = makeBooksTool(noClient);
      const r = await tool.execute({ op: 'build_overdue_report' }, ctx);
      assert.equal(r.ok, true);
      assert.ok((r as any).value.report);
    });

    it('build_overdue_report: upstream_failure when financeOps throws', async () => {
      const throwingOps: Partial<ZohoFinanceOps> = {
        buildOverdueReport: async () => { throw new Error('finance down'); },
      };
      const tool = makeBooksTool(noClient, throwingOps as ZohoFinanceOps);
      const r = await tool.execute({ op: 'build_overdue_report' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });

    it('infra throws on list → upstream_failure', async () => {
      const throwingPaginated = {
        listRecords: async () => { throw new Error('err'); },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = createZohoBooksTool({
        getClient: yesClient,
        financeOps: fakeFinanceOps as ZohoFinanceOps,
        booksClient: throwingPaginated,
        cloudinary: { isAvailable: false, uploadCsvBuffer: async () => null } as any,
      });
      const r = await tool.execute({ op: 'list_invoices' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});
