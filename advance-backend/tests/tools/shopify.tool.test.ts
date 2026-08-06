import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createShopifyTools,
} from '../../src/application/tools/families/shopify.tool.ts';
import { ShopifySnapshotDataExportSource } from '../../src/application/data-export/data-export.sources.ts';
import { parseDataExportOfferPayload } from '../../src/application/data-export/export-offer.ts';
import { ShopifyServiceError } from '../../src/application/shopify/shopify.service.ts';
import type { ShopifyOperationResult } from '../../src/application/shopify/shopify.service.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeCtx } from './tool-test.helpers.ts';

const connectionId = '11111111-1111-4111-8111-111111111111';

const completed: ShopifyOperationResult = {
  status: 'complete',
  operation: 'sales_summary',
  store: { domain: 'demo.myshopify.com', name: 'Demo store' },
  apiVersion: '2026-07',
  data: {
    columns: [{ name: 'total_sales', dataType: 'MONEY', displayName: 'Total sales' }],
    rows: [{ total_sales: '123.45' }],
  },
  requestId: 'request-1',
  retrievedAt: '2026-08-02T00:00:00.000Z',
  message: 'Shopify request completed.',
};

function makeAudit(overrides: { readonly recordRequired?: (input: unknown) => Promise<void> } = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    service: {
      record: () => {},
      recordRequired: async (input: unknown) => {
        calls.push(input);
        await overrides.recordRequired?.(input);
      },
    } as any,
  };
}

const orderNode = {
  id: 'gid://shopify/Order/1',
  name: '#1001',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'FULFILLED',
  sourceName: 'web',
  currentTotalPriceSet: { shopMoney: { amount: '99.00', currencyCode: 'USD' } },
};

const customerNode = {
  id: 'gid://shopify/Customer/1',
  state: 'ENABLED',
  tags: ['vip'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  amountSpent: { amount: '500.00', currencyCode: 'USD' },
};

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    analytics: async () => completed,
    orders: async () => ({
      ...completed,
      operation: 'list_orders',
      data: [orderNode],
    }),
    customers: async () => ({
      ...completed,
      operation: 'list_customers',
      data: [customerNode],
    }),
    ...overrides,
  } as any;
}

function makeTools(
  service = makeService(),
  audit = makeAudit(),
  exportCandidates?: Parameters<typeof createShopifyTools>[0]['exportCandidates'],
) {
  return {
    tools: createShopifyTools({
      service,
      audit: audit.service,
      ...(exportCandidates ? { exportCandidates } : {}),
    }),
    audit,
  };
}

const validAnalyticsArgs = {
  connectionId,
  operation: 'sales_summary' as const,
  period: { kind: 'preset' as const, value: 'last_month' as const },
};

const validOrdersArgs = {
  connectionId,
  operation: 'list_orders' as const,
};

const validCustomersArgs = {
  connectionId,
  operation: 'list_customers' as const,
};

describe('Shopify tool contracts', () => {
  it('accepts only closed schemas and rejects raw queries, credentials, transport fields, and arbitrary fields', () => {
    const { tools } = makeTools();
    const cases = [
      [tools[0], validAnalyticsArgs],
      [tools[1], validOrdersArgs],
      [tools[2], validCustomersArgs],
    ] as const;

    for (const [tool, valid] of cases) {
      assert.equal(tool.argsSchema.safeParse(valid).success, true);
      for (const forbidden of [
        { query: 'FROM sales SHOW total_sales' },
        { accessToken: 'shpat_live_secret' },
        { refreshToken: 'refresh_live_secret' },
        { headers: { authorization: 'Bearer secret' } },
        { arbitraryField: 'must be rejected' },
      ]) {
        assert.equal(
          tool.argsSchema.safeParse({ ...valid, ...forbidden }).success,
          false,
          `${tool.id} accepted ${Object.keys(forbidden)[0]}`,
        );
      }
    }

    assert.match(tools[0].parameterDocs, /Raw ShopifyQL/);
    assert.match(tools[2].parameterDocs, /includeContact/);
    assert.equal(JSON.stringify(tools[0]).includes('shpat_live_secret'), false);
  });

  it('keeps analytics, orders, and customers as separate independently governed RBAC capabilities', () => {
    const { tools } = makeTools();
    const expected = ['shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers'];

    for (let index = 0; index < tools.length; index += 1) {
      const ownPermission = tools[index]!.permissionCheck(
        index === 0 ? validAnalyticsArgs : index === 1 ? validOrdersArgs : validCustomersArgs,
        makeAllowedPerm(expected[index]!, ['read']),
      );
      assert.equal(ownPermission.ok, true, `${expected[index]} should be independently grantable`);

      const otherPermission = tools[index]!.permissionCheck(
        index === 0 ? validAnalyticsArgs : index === 1 ? validOrdersArgs : validCustomersArgs,
        makeAllowedPerm(expected[(index + 1) % expected.length]!, ['read']),
      );
      assert.equal(otherPermission.ok, false, `${expected[index]} inherited another Shopify capability`);
    }
  });

  it('records a success audit without returning or auditing provider secrets or result data', async () => {
    const audit = makeAudit();
    const { tools } = makeTools(makeService(), audit);
    const result = await tools[0]!.execute(validAnalyticsArgs, makeCtx('shopifyAnalytics', ['read']));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview?.rows.length, 1);
    assert.equal(result.value.preview?.rows[0]?.['Total sales'], '123.45');
    assert.equal('data' in result.value, false);
    assert.equal(audit.calls.length, 1);
    const auditInput = audit.calls[0] as any;
    assert.equal(auditInput.outcome, 'success');
    assert.equal(auditInput.metadata.operation, 'sales_summary');
    assert.equal(auditInput.metadata.connectionId, connectionId);
    assert.equal('data' in auditInput.metadata, false);
    assert.equal(JSON.stringify(auditInput).includes('123.45'), false);
    assert.equal(JSON.stringify(auditInput).includes('shpat_live_secret'), false);
  });

  it('fails closed when required success auditing fails', async () => {
    const audit = makeAudit({ recordRequired: async () => { throw new Error('audit database unavailable'); } });
    const { tools } = makeTools(makeService(), audit);
    const result = await tools[0]!.execute(validAnalyticsArgs, makeCtx('shopifyAnalytics', ['read']));

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.error.payload.reason, 'unrecoverable');
    assert.match(result.ok ? '' : result.error.message, /safely audited/);
  });

  it('maps provider failures to stable tool errors and requires failure auditing too', async () => {
    const mappings = [
      ['bad_args', 'bad_args'],
      ['inaccessible', 'permission_denied'],
      ['missing_scope', 'permission_denied'],
      ['rate_limited', 'retryable'],
      ['provider_failure', 'upstream_failure'],
    ] as const;

    for (const [code, expectedReason] of mappings) {
      const audit = makeAudit();
      const service = makeService({
        analytics: async () => {
          throw new ShopifyServiceError(code, `synthetic ${code}`);
        },
      });
      const { tools } = makeTools(service, audit);
      const result = await tools[0]!.execute(validAnalyticsArgs, makeCtx('shopifyAnalytics', ['read']));

      assert.equal(result.ok, false, code);
      assert.equal(result.ok ? undefined : result.error.payload.reason, expectedReason, code);
      assert.equal(audit.calls.length, 1, `failure for ${code} was not audited`);
      assert.equal((audit.calls[0] as any).outcome, 'failure');
      assert.equal((audit.calls[0] as any).metadata.failureCode, code);
    }
  });

  it('publishes an export candidate for analytics on Lark when dataExport create is granted', async () => {
    const candidates: unknown[] = [];
    const { tools } = makeTools(makeService(), makeAudit(), {
      publishCandidate: async (payload: unknown) => {
        candidates.push(payload);
        return {
          candidateId: '11111111-1111-4111-8111-111111111111',
          expiresAt: new Date('2026-08-03T00:00:00.000Z'),
        };
      },
    });
    const ctx = makeCtx('shopifyAnalytics', ['read'], { chatId: 'oc-chat' });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tools[0]!.execute(validAnalyticsArgs, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.exportCandidate?.candidateId, '11111111-1111-4111-8111-111111111111');
    assert.equal(result.value.preview?.rows.length, 1);
    assert.ok(result.value.preview!.rows.length <= 25);
    const payload = parseDataExportOfferPayload(candidates[0]);
    assert.equal(payload.source.kind, 'shopify_snapshot');
    assert.equal(payload.source.connectionId, connectionId);
    assert.equal(payload.source.toolId, 'shopifyAnalytics');
    assert.equal(payload.source.args.operation, 'sales_summary');
  });

  it('omits export candidate without dataExport create permission', async () => {
    const { tools } = makeTools(makeService(), makeAudit(), {
      publishCandidate: async () => ({
        candidateId: '11111111-1111-4111-8111-111111111111',
        expiresAt: new Date('2026-08-03T00:00:00.000Z'),
      }),
    });
    const result = await tools[0]!.execute(
      validAnalyticsArgs,
      makeCtx('shopifyAnalytics', ['read'], { chatId: 'oc-chat' }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.exportCandidate, undefined);
  });

  it('replays analytics exports through the shopify snapshot adapter', async () => {
    const adapter = new ShopifySnapshotDataExportSource({
      analytics: async () => completed,
    });
    const pages: Array<{ rows: Record<string, unknown>[] }> = [];
    for await (const page of adapter.read({
      kind: 'shopify_snapshot',
      connectionId,
      toolId: 'shopifyAnalytics',
      args: validAnalyticsArgs,
    }, {
      companyId: 'co-test',
      userId: 'user-test',
    })) {
      pages.push({ rows: [...page.rows] });
    }
    assert.deepEqual(pages, [{ rows: [{ 'Total sales': '123.45' }] }]);
  });

  it('publishes an export candidate for list_orders on Lark when dataExport create is granted', async () => {
    const candidates: unknown[] = [];
    const { tools } = makeTools(makeService(), makeAudit(), {
      publishCandidate: async (payload: unknown) => {
        candidates.push(payload);
        return {
          candidateId: '22222222-2222-4222-8222-222222222222',
          expiresAt: new Date('2026-08-03T00:00:00.000Z'),
        };
      },
    });
    const ctx = makeCtx('shopifyOrders', ['read'], { chatId: 'oc-chat' });
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));

    const result = await tools[1]!.execute(validOrdersArgs, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.exportCandidate?.candidateId, '22222222-2222-4222-8222-222222222222');
    assert.equal(result.value.preview?.rows.length, 1);
    assert.equal(result.value.preview?.rows[0]?.Order, '#1001');
    assert.ok(Array.isArray(result.value.data));
    const payload = parseDataExportOfferPayload(candidates[0]);
    assert.equal(payload.source.toolId, 'shopifyOrders');
    assert.equal(payload.source.args.operation, 'list_orders');
    assert.equal(payload.source.args.first, 100);
    assert.equal('after' in payload.source.args, false);
  });

  it('replays paginated order exports through the shopify snapshot adapter', async () => {
    let call = 0;
    const adapter = new ShopifySnapshotDataExportSource({
      analytics: async () => completed,
      orders: async () => {
        call += 1;
        if (call === 1) {
          return {
            ...completed,
            operation: 'list_orders',
            data: [orderNode],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
          };
        }
        return {
          ...completed,
          operation: 'list_orders',
          data: [{ ...orderNode, name: '#1002' }],
          pageInfo: { hasNextPage: false },
        };
      },
      customers: async () => ({
        ...completed,
        operation: 'list_customers',
        data: [customerNode],
      }),
    });
    const pages: Array<{ rows: Record<string, unknown>[]; hasMore?: boolean }> = [];
    for await (const page of adapter.read({
      kind: 'shopify_snapshot',
      connectionId,
      toolId: 'shopifyOrders',
      args: { connectionId, operation: 'list_orders', first: 100 },
    }, {
      companyId: 'co-test',
      userId: 'user-test',
    })) {
      pages.push({ rows: [...page.rows], ...(page.hasMore ? { hasMore: page.hasMore } : {}) });
    }
    assert.equal(call, 2);
    assert.equal(pages.length, 2);
    assert.equal(pages[0]?.hasMore, true);
    assert.equal(pages[0]?.rows[0]?.Order, '#1001');
    assert.equal(pages[1]?.rows[0]?.Order, '#1002');
  });

  it('fails closed when failure auditing fails instead of exposing an upstream result', async () => {
    const audit = makeAudit({ recordRequired: async () => { throw new Error('audit write failed'); } });
    const service = makeService({
      orders: async () => { throw new ShopifyServiceError('rate_limited', 'try later'); },
    });
    const { tools } = makeTools(service, audit);
    const result = await tools[1]!.execute(validOrdersArgs, makeCtx('shopifyOrders', ['read']));

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.error.payload.reason, 'unrecoverable');
    assert.match(result.ok ? '' : result.error.message, /safely audited/);
  });
});
