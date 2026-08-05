import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createShopifyTools,
} from '../../src/application/tools/families/shopify.tool.ts';
import { ShopifyServiceError } from '../../src/application/shopify/shopify.service.ts';
import type { ShopifyOperationResult } from '../../src/application/shopify/shopify.service.ts';
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

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    analytics: async () => completed,
    orders: async () => ({ ...completed, operation: 'list_orders' }),
    customers: async () => ({ ...completed, operation: 'list_customers' }),
    ...overrides,
  } as any;
}

function makeTools(service = makeService(), audit = makeAudit()) {
  return { tools: createShopifyTools({ service, audit: audit.service }), audit };
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
