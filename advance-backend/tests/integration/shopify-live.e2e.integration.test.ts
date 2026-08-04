import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ShopifyService } from '../../src/application/shopify/shopify.service';
import { ShopifyConnectionService } from '../../src/application/shopify/shopify-connection.service';
import {
  ShopifyAnalyticsArgsSchema,
  ShopifyCustomersArgsSchema,
  ShopifyOrdersArgsSchema,
} from '../../src/application/shopify/shopify.types';
import { ShopifyAdminClient } from '../../src/infrastructure/shopify/shopify-admin.client';
import { ShopifyOAuthService } from '../../src/infrastructure/shopify/shopify-oauth.service';
import { IntegrationConnectionRepository } from '../../src/infrastructure/persistence/integration-connection.repository';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { normalizeShopDomain } from '../../src/domain/shopify/shopify-shop';

const shop = normalizeShopDomain(process.env['SHOPIFY_E2E_SHOP'] ?? '');
const accessToken = process.env['SHOPIFY_E2E_ACCESS_TOKEN']?.trim();
const enabled = process.env['RUN_SHOPIFY_E2E'] === '1' && Boolean(shop && accessToken && process.env['DATABASE_URL']);
const apiVersion = process.env['SHOPIFY_API_VERSION'] ?? '2026-07';
const grantedScopes = new Set(
  (process.env['SHOPIFY_E2E_SCOPES'] ?? 'read_reports,read_orders,read_customers')
    .split(',').map(scope => scope.trim()).filter(Boolean),
);

test('live Shopify dev store: production service path covers reports, orders, pagination, customers, and attribution', {
  skip: !enabled ? 'Set RUN_SHOPIFY_E2E=1, SHOPIFY_E2E_SHOP, SHOPIFY_E2E_ACCESS_TOKEN, and DATABASE_URL.' : false,
  timeout: 120_000,
}, async () => {
  const client = new ShopifyAdminClient({ apiVersion, timeoutMs: 20_000, maxRetries: 2 });
  const identity = await client.query<{ shop: { id: string; name: string; myshopifyDomain: string } }>({
    shop: shop!,
    accessToken: accessToken!,
    query: 'query DivoLiveIdentity { shop { id name myshopifyDomain } }',
  });
  assert.equal(normalizeShopDomain(identity.data.shop.myshopifyDomain), shop);
  assert.match(identity.data.shop.id, /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/);

  const prisma = new PrismaClient();
  const suffix = randomUUID();
  let companyId = '';
  let userId = '';
  try {
    const user = await prisma.user.create({ data: { email: `shopify-live-${suffix}@example.test`, password: 'integration-only' } });
    const company = await prisma.company.create({ data: { name: `Shopify live ${suffix}` } });
    await prisma.adminMembership.create({ data: { userId: user.id, companyId: company.id, role: 'COMPANY_ADMIN', isActive: true } });
    companyId = company.id;
    userId = user.id;
    const repository = new IntegrationConnectionRepository(prisma, {
      INTEGRATION_TOKEN_ENCRYPTION_KEY: `shopify-live-${suffix}`,
    } as never);
    const saved = await repository.upsertShopifyConnection({
      companyId,
      ownerType: 'company',
      createdBy: userId,
      shopDomain: shop!,
      shopName: identity.data.shop.name,
      shopGraphqlId: identity.data.shop.id,
      accessToken: accessToken!,
      scopes: [...grantedScopes],
      apiVersion,
    });
    assert.ok(saved.ok);
    const connectionId = saved.value.id;
    const raw = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    assert.notEqual(raw.accessTokenEncrypted, accessToken);
    const oauth = new ShopifyOAuthService({
      clientId: 'live-test-unused', clientSecret: 'live-test-unused',
      redirectUri: 'https://backend.example.test/api/shopify/auth/callback',
      scopes: [...grantedScopes], timeoutMs: 20_000, maxRetries: 2, maxCallbackSkewSeconds: 300,
    });
    const service = new ShopifyService({
      client,
      apiVersion,
      connections: new ShopifyConnectionService({ repository, oauth }),
    });
    const ctx = { runContext: { companyId, userId } } as never;

  const report = await service.analytics(ShopifyAnalyticsArgsSchema.parse({
    connectionId,
    operation: 'sales_timeseries',
    metrics: ['total_sales', 'orders'],
    granularity: 'day',
    period: { kind: 'range', since: '-30d', until: 'today' },
  }), ctx);
  assert.equal(report.operation, 'sales_timeseries');
  assert.ok(Array.isArray((report.data as { rows: unknown[] }).rows));

  for (const input of [
    { connectionId, operation: 'product_performance', period: { kind: 'preset', value: 'last_month' } },
    { connectionId, operation: 'customer_acquisition', granularity: 'month', period: { kind: 'preset', value: 'last_month' } },
    { connectionId, operation: 'inventory_position', period: { kind: 'range', since: '-30d', until: 'today' } },
    { connectionId, operation: 'payments_summary', period: { kind: 'preset', value: 'last_month' } },
    { connectionId, operation: 'payments_by_method', period: { kind: 'preset', value: 'last_month' } },
  ] as const) {
    const result = await service.analytics(ShopifyAnalyticsArgsSchema.parse(input), ctx);
    assert.equal(result.operation, input.operation);
    assert.ok(Array.isArray((result.data as { rows: unknown[] }).rows));
  }

  const orders = await service.orders(ShopifyOrdersArgsSchema.parse({
    connectionId, operation: 'list_orders', first: 100,
  }), ctx);
  assert.ok(Array.isArray(orders.data));
  assert.equal(typeof orders.pageInfo?.hasNextPage, 'boolean');

  const customerCount = await service.customers(ShopifyCustomersArgsSchema.parse({
    connectionId, operation: 'count_customers', limit: 10_000,
  }), ctx);
  assert.equal(Number.isInteger((customerCount.data as { count: number }).count), true);

  const customers = await service.customers(ShopifyCustomersArgsSchema.parse({
    connectionId, operation: 'list_customers', first: 100,
  }), ctx);
  assert.ok(Array.isArray(customers.data));
  assert.equal(JSON.stringify(customers.data).includes('displayName'), false);

  const firstOrder = (orders.data as Array<{ id?: unknown; name?: unknown }>)[0];
  if (typeof firstOrder?.id === 'string' && typeof firstOrder.name === 'string') {
    const detail = await service.orders(ShopifyOrdersArgsSchema.parse({
      connectionId, operation: 'get_order', orderId: firstOrder.id,
    }), ctx);
    assert.equal((detail.data as { id?: string } | null)?.id, firstOrder.id);

    const byName = await service.orders(ShopifyOrdersArgsSchema.parse({
      connectionId, operation: 'get_order_by_identifier', name: firstOrder.name,
    }), ctx);
    assert.equal((byName.data as { id?: string } | null)?.id, firstOrder.id);

    const attribution = await service.orders(ShopifyOrdersArgsSchema.parse({
      connectionId, operation: 'get_order_attribution', orderId: firstOrder.id,
    }), ctx);
    assert.equal((attribution.data as { id?: string } | null)?.id, firstOrder.id);

    const lineItems = await service.orders(ShopifyOrdersArgsSchema.parse({
      connectionId, operation: 'list_order_line_items', orderId: firstOrder.id, first: 100,
    }), ctx);
    assert.equal((lineItems.data as { orderId?: string } | null)?.orderId, firstOrder.id);
    if (lineItems.pageInfo?.hasNextPage) {
      assert.ok(lineItems.pageInfo.endCursor);
      const next = await service.orders(ShopifyOrdersArgsSchema.parse({
        connectionId,
        operation: 'list_order_line_items',
        orderId: firstOrder.id,
        first: 100,
        after: lineItems.pageInfo.endCursor,
      }), ctx);
      assert.equal((next.data as { orderId?: string } | null)?.orderId, firstOrder.id);
    }
  }

    const touched = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    assert.ok(touched.lastUsedAt);
  } finally {
    if (companyId) await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
