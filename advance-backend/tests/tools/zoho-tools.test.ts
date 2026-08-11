/**
 * Unit tests for Zoho tool families: CRM and Books.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeDeniedPerm, makeCtx } from './tool-test.helpers.ts';

import { createZohoCrmTool }   from '../../src/application/tools/families/zoho-crm.tool.ts';
import { createZohoBooksTool } from '../../src/application/tools/families/zoho-books.tool.ts';
import type { ZohoFinanceOps } from '../../src/application/zoho/zoho-finance-ops.ts';
import type { ZohoCrmOps } from '../../src/application/zoho/zoho-crm-ops.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';
import type { ZohoCrmPaginatedClient } from '../../src/infrastructure/zoho/zoho-crm-paginated.client.ts';
import { assertLosslessPagingFixture } from './lossless-paging.fixture.ts';

// ─── zoho-crm ─────────────────────────────────────────────────────────────────

describe('zohoCrm tool', () => {
  const fakePaginatedCrmClient = {
    listRecords:   async () => ({ items: [{ id: 'lead-1', Last_Name: 'Alice' }], hasMore: false, page: 1 }),
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


  const makeCrmTool = () =>
    createZohoCrmTool({
      crmClient:  fakePaginatedCrmClient,
      crmOps:     fakeCrmOps,
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

    it('documents governed terminal paging instead of the legacy export planner', () => {
      const tool = makeCrmTool();
      assert.match(tool.description, /governed local script using page\/nextPage/);
      assert.doesNotMatch(`${tool.description}\n${tool.parameterDocs}`, /dataExport|export candidate/i);
    });

    it('rejects the retired embedded script contract', () => {
      const tool = makeCrmTool();
      assert.equal(tool.argsSchema.safeParse({ op: 'list', module: 'Deals', script: 'return data' }).success, false);
      assert.doesNotMatch(`${tool.description}\n${tool.parameterDocs}`, /script mode|scriptArgs|sandbox/i);
    });

    it('rejects ambiguous page and pageToken input', () => {
      const tool = makeCrmTool();
      assert.equal(tool.argsSchema.safeParse({
        op: 'list', module: 'Deals', page: 2, pageToken: 'opaque',
      }).success, false);
    });

    it('rejects filter criteria on list instead of silently ignoring it', () => {
      const tool = makeCrmTool();
      assert.equal(tool.argsSchema.safeParse({
        op: 'list', module: 'Deals', criteria: '(Closing_Date:between:2026-07-01,2026-07-31)',
      }).success, false);
    });

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

    it('list exposes the exact next page or provider continuation token', async () => {
      const calls: unknown[] = [];
      const paginatedClient = {
        ...fakePaginatedCrmClient,
        listRecords: async (input: unknown) => {
          calls.push(input);
          return { items: [{ id: 'lead-1' }], hasMore: true, nextPageToken: 'next-token' };
        },
      } as unknown as ZohoCrmPaginatedClient;
      const tool = createZohoCrmTool({ crmClient: paginatedClient, crmOps: fakeCrmOps });

      const r = await tool.execute({ op: 'list', module: 'Leads', pageToken: 'current-token' }, ctx);

      assert.equal(r.ok, true);
      assert.equal((r as any).value.hasMore, true);
      assert.equal((r as any).value.nextPageToken, 'next-token');
      assert.equal((r as any).value.page, undefined);
      assert.deepEqual(calls, [{
        companyId: 'co-test',
        userId: 'user-test',
        module: 'Leads',
        perPage: 25,
        pageToken: 'current-token',
      }]);
    });

    it('preserves a complete fixture across page and opaque-token continuations', async () => {
      const source = Array.from({ length: 405 }, (_, index) => ({
        id: `lead-${String(index + 1).padStart(3, '0')}`,
        Last_Name: `Lead ${index + 1}`,
      }));
      const calls: Array<{ page?: number; pageToken?: string; perPage?: number }> = [];
      const paginatedClient = {
        ...fakePaginatedCrmClient,
        listRecords: async (input: any) => {
          calls.push(input);
          if (input.pageToken === 'cursor-final') {
            return { items: source.slice(400), hasMore: false };
          }
          const page = input.page ?? 1;
          const start = (page - 1) * 200;
          return {
            items: source.slice(start, start + 200),
            hasMore: true,
            page,
            ...(page === 2 ? { nextPageToken: 'cursor-final' } : {}),
          };
        },
      } as unknown as ZohoCrmPaginatedClient;
      const tool = createZohoCrmTool({
        crmClient: paginatedClient,
        crmOps: fakeCrmOps,
      });
      type Cursor = { readonly page: number } | { readonly pageToken: string };

      const proof = await assertLosslessPagingFixture<Record<string, unknown>, Cursor>({
        expectedIds: source.map(row => row.id),
        initialCursor: { page: 1 },
        readPage: async cursor => {
          const result = await tool.execute({
            op: 'list',
            module: 'Leads',
            limit: 200,
            ...cursor,
          }, { ...ctx, resultAudience: 'local_file' });
          assert.equal(result.ok, true);
          if (!result.ok) throw result.error;
          const nextCursor = result.value.nextPageToken
            ? { pageToken: result.value.nextPageToken } as const
            : result.value.nextPage
              ? { page: result.value.nextPage } as const
              : undefined;
          return {
            rows: Array.isArray(result.value.data)
              ? result.value.data as Record<string, unknown>[]
              : [],
            hasMore: result.value.hasMore ?? false,
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
        rowId: row => String(row['id']),
      });

      assert.equal(proof.rows.length, 405);
      assert.deepEqual(proof.pageSizes, [200, 200, 5]);
      assert.deepEqual(calls.map(call => ({
        page: call.page,
        pageToken: call.pageToken,
        perPage: call.perPage,
      })), [
        { page: 1, pageToken: undefined, perPage: 200 },
        { page: 2, pageToken: undefined, perPage: 200 },
        { page: undefined, pageToken: 'cursor-final', perPage: 200 },
      ]);
    });

    it('personalized scope returns only records with the signed-in email', async () => {
      const scopedClient = {
        ...fakePaginatedCrmClient,
        listRecords: async () => ({
          items: [
            { id: 'lead-owned', Email: 'member@example.com' },
            { id: 'lead-other', Email: 'other@example.com' },
          ],
          hasMore: false,
          page: 1,
        }),
      } as unknown as ZohoCrmPaginatedClient;
      const tool = createZohoCrmTool({ crmClient: scopedClient, crmOps: fakeCrmOps });
      const personalized = makeCtx('zohoCrm', ['read'], { requesterEmail: 'member@example.com' });
      (personalized.perm as any).department = { zohoReadScope: 'personalized' };

      const r = await tool.execute({ op: 'list', module: 'Leads' }, personalized);

      assert.equal(r.ok, true);
      assert.deepEqual((r as any).value.data.map((record: { id: string }) => record.id), ['lead-owned']);
    });

    it('personalized scope fails closed when the member email is missing', async () => {
      const tool = makeCrmTool();
      const personalized = makeCtx('zohoCrm', ['read']);
      (personalized.perm as any).department = { zohoReadScope: 'personalized' };

      const r = await tool.execute({ op: 'list', module: 'Leads' }, personalized);

      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'permission_denied');
    });

    it('search: ok with criteria', async () => {
      const tool = makeCrmTool();
      const r = await tool.execute({ op: 'search', module: 'Leads', criteria: '(Last_Name:contains:Alice)' }, ctx);
      assert.equal(r.ok, true);
    });

    it('continues search pages until Zoho reaches its documented 2,000-record limit', async () => {
      const calls: unknown[] = [];
      const paginatedClient = {
        ...fakePaginatedCrmClient,
        searchRecords: async (input: unknown) => {
          calls.push(input);
          return { items: [{ id: 'lead-201' }], hasMore: true, page: 2 };
        },
      } as unknown as ZohoCrmPaginatedClient;
      const tool = createZohoCrmTool({ crmClient: paginatedClient, crmOps: fakeCrmOps });

      const r = await tool.execute({
        op: 'search', module: 'Leads', criteria: '(Last_Name:contains:Alice)', page: 2,
      }, { ...ctx, resultAudience: 'local_file' });

      assert.equal(r.ok, true);
      assert.equal((r as any).value.hasMore, true);
      assert.equal((r as any).value.page, 2);
      assert.equal((r as any).value.nextPage, 3);
      assert.equal((r as any).value.truncated, undefined);
      assert.deepEqual(calls, [{
        companyId: 'co-test',
        userId: 'user-test',
        module: 'Leads',
        criteria: '(Last_Name:contains:Alice)',
        perPage: 200,
        page: 2,
      }]);
    });

    it('reports the real Zoho search ceiling only after page 10', async () => {
      const paginatedClient = {
        ...fakePaginatedCrmClient,
        searchRecords: async () => ({ items: [{ id: 'lead-2000' }], hasMore: true, page: 10 }),
      } as unknown as ZohoCrmPaginatedClient;
      const tool = createZohoCrmTool({ crmClient: paginatedClient, crmOps: fakeCrmOps });

      const r = await tool.execute({
        op: 'search', module: 'Leads', criteria: '(Last_Name:contains:Alice)', page: 10,
      }, ctx);

      assert.equal(r.ok, true);
      assert.equal((r as any).value.nextPage, undefined);
      assert.equal((r as any).value.truncated, true);
      assert.match((r as any).value.message, /2,000-record limit/i);
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
        crmClient: throwingPaginated,
        crmOps: fakeCrmOps,
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
  } as unknown as ZohoBooksPaginatedClient;

  const makeBooksTool = (financeOps = fakeFinanceOps as ZohoFinanceOps) =>
    createZohoBooksTool({
      financeOps,
      booksClient: fakePaginatedBooksClient,
    });

  describe('permissionCheck', () => {
    it('returns "read" for op=list_invoices', () => {
      const tool = makeBooksTool();
      const r = tool.permissionCheck({ op: 'list_invoices' }, makeAllowedPerm('zohoBooks', ['read']));
      assert.equal((r as any).value, 'read');
    });

    it('returns "create" for op=create_invoice', () => {
      const tool = makeBooksTool();
      const r = tool.permissionCheck({ op: 'create_invoice' }, makeAllowedPerm('zohoBooks', ['create']));
      assert.equal((r as any).value, 'create');
    });

    it('denies when not in allowedActionsByTool', () => {
      const tool = makeBooksTool();
      const r = tool.permissionCheck({ op: 'list_invoices' }, makeDeniedPerm());
      assert.equal(r.ok, false);
    });

    it('denies create when only read allowed', () => {
      const tool = makeBooksTool();
      const r = tool.permissionCheck({ op: 'create_invoice' }, makeAllowedPerm('zohoBooks', ['read']));
      assert.equal(r.ok, false);
    });
  });

  describe('execute', () => {
    const ctx = makeCtx('zohoBooks', ['read', 'create']);

    it('documents governed terminal paging instead of the legacy export planner', () => {
      const tool = makeBooksTool();
      assert.match(tool.description, /page\/nextPage from one governed local Python file/);
      assert.doesNotMatch(`${tool.description}\n${tool.parameterDocs}`, /dataExport|export candidate/i);
    });

    it('rejects the retired embedded script contract', () => {
      const tool = makeBooksTool();
      assert.equal(tool.argsSchema.safeParse({ op: 'list_expenses', script: 'return data' }).success, false);
      assert.doesNotMatch(`${tool.description}\n${tool.parameterDocs}`, /script mode|scriptArgs|sandbox|4,000-record/i);
    });

    it('get_invoice: provider error → upstream_failure', async () => {
      const tool = createZohoBooksTool({
        financeOps: fakeFinanceOps as ZohoFinanceOps,
        booksClient: {
          getEndpoint: async () => { throw new Error('Zoho Books 401: invalid token'); },
        } as unknown as ZohoBooksPaginatedClient,
      });
      const r = await tool.execute({ op: 'get_invoice', invoiceId: '1500000000001' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });

    it('list_invoices: ok with invoices', async () => {
      const tool = makeBooksTool();
      const r = await tool.execute({ op: 'list_invoices' }, ctx);
      assert.equal(r.ok, true);
    });

    it('list_invoices forwards and returns provider pages', async () => {
      const calls: unknown[] = [];
      const booksClient = {
        listRecords: async (input: unknown) => {
          calls.push(input);
          return { organizationId: 'org-1', items: [{ invoice_id: 'inv-26' }], hasMore: true, page: 2 };
        },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = createZohoBooksTool({ financeOps: fakeFinanceOps as ZohoFinanceOps, booksClient });

      const r = await tool.execute({ op: 'list_invoices', page: 2 }, ctx);

      assert.equal(r.ok, true);
      assert.equal((r as any).value.page, 2);
      assert.equal((r as any).value.nextPage, 3);
      assert.equal((calls[0] as any).page, 2);
    });

    it('personalized scope filters Books records after Zoho responds', async () => {
      const booksClient = {
        listRecords: async () => ({
          organizationId: 'org-1',
          items: [
            { invoice_id: 'inv-owned', email: 'member@example.com', total: 10 },
            { invoice_id: 'inv-other', email: 'other@example.com', total: 20 },
          ],
          hasMore: false,
          page: 1,
        }),
      } as unknown as ZohoBooksPaginatedClient;
      const tool = createZohoBooksTool({
        financeOps: fakeFinanceOps as ZohoFinanceOps,
        booksClient,
      });
      const personalized = makeCtx('zohoBooks', ['read'], { requesterEmail: 'member@example.com' });
      (personalized.perm as any).department = { zohoReadScope: 'personalized' };

      const r = await tool.execute({ op: 'list_invoices' }, personalized);

      assert.equal(r.ok, true);
      assert.deepEqual(
        (r as any).value.preview.rows.map((record: { id: string }) => record.id),
        ['inv-owned'],
      );
    });

    it('personalized scope rejects aggregate Books reports', async () => {
      const tool = makeBooksTool();
      const personalized = makeCtx('zohoBooks', ['read'], { requesterEmail: 'member@example.com' });
      (personalized.perm as any).department = { zohoReadScope: 'personalized' };

      const r = await tool.execute({ op: 'build_overdue_report' }, personalized);

      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'permission_denied');
    });

    it('get_invoice: ok with invoice', async () => {
      const tool = makeBooksTool();
      const r = await tool.execute({ op: 'get_invoice', invoiceId: 'inv-1' }, ctx);
      assert.equal(r.ok, true);
    });

    it('list_contacts: ok with contacts', async () => {
      const tool = makeBooksTool();
      const r = await tool.execute({ op: 'list_contacts' }, ctx);
      assert.equal(r.ok, true);
    });

    it('list_expenses: ok with expenses', async () => {
      const tool = makeBooksTool();
      const r = await tool.execute({ op: 'list_expenses' }, ctx);
      assert.equal(r.ok, true);
    });

    it('build_overdue_report: ok using financeOps (bypasses client)', async () => {
      const tool = makeBooksTool();
      const r = await tool.execute({ op: 'build_overdue_report' }, ctx);
      assert.equal(r.ok, true);
      assert.ok((r as any).value.report);
    });

    it('build_overdue_report: upstream_failure when financeOps throws', async () => {
      const throwingOps: Partial<ZohoFinanceOps> = {
        buildOverdueReport: async () => { throw new Error('finance down'); },
      };
      const tool = makeBooksTool(throwingOps as ZohoFinanceOps);
      const r = await tool.execute({ op: 'build_overdue_report' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });

    it('infra throws on list → upstream_failure', async () => {
      const throwingPaginated = {
        listRecords: async () => { throw new Error('err'); },
      } as unknown as ZohoBooksPaginatedClient;
      const tool = createZohoBooksTool({
        financeOps: fakeFinanceOps as ZohoFinanceOps,
        booksClient: throwingPaginated,
      });
      const r = await tool.execute({ op: 'list_invoices' }, ctx);
      assert.equal(r.ok, false);
      assert.equal((r as any).error.payload.reason, 'upstream_failure');
    });
  });
});
