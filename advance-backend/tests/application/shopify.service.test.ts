import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShopifyService, ShopifyServiceError } from '../../src/application/shopify/shopify.service';
import { ShopifyAnalyticsArgsSchema, ShopifyCustomersArgsSchema } from '../../src/application/shopify/shopify.types';
import { ShopifyApiError } from '../../src/infrastructure/shopify/shopify-admin.client';

const connection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  shopDomain: 'test-store.myshopify.com',
  shopName: 'Test Store',
  accessToken: 'token-v1',
  scopes: ['read_reports', 'read_orders', 'read_customers'],
  apiVersion: '2026-07',
};

const context = {
  runContext: { companyId: 'company-1', userId: 'user-1' },
  perm: { allowedActionsByTool: new Map(), allowedToolIds: new Set(), decisions: [] },
  correlationId: 'correlation-1',
  logger: {},
  clock: {},
} as never;

describe('ShopifyService', () => {
  it('returns structured ShopifyQL rows and never accepts a model-authored raw query', async () => {
    let request: Record<string, unknown> | undefined;
    const service = buildService({
      query: async input => {
        request = input;
        return {
          data: {
            shopifyqlQuery: {
              tableData: {
                columns: [{ name: 'total_sales', dataType: 'MONEY', displayName: 'Total sales' }],
                rows: [{ total_sales: '125.50' }],
              },
              parseErrors: [],
            },
          },
          extensions: { shopifyqlCost: { requestedQueryCost: 1, currentlyAvailable: 99 } },
          requestId: 'request-1',
        };
      },
    });

    const result = await service.analytics({
      connectionId: connection.connectionId,
      operation: 'sales_summary',
      metrics: ['total_sales'],
      period: { kind: 'preset', value: 'last_month' },
    }, context);

    assert.equal(result.status, 'complete');
    assert.equal(result.requestId, 'request-1');
    assert.deepEqual((request?.['variables'] as Record<string, unknown>)['query'], 'FROM sales\nSHOW total_sales\nDURING last_month');
    assert.equal(JSON.stringify(request).includes('rawQuery'), false);
  });

  it('executes every supported commerce analytics dataset through the same compiled service path', async () => {
    const queries: string[] = [];
    const service = buildService({
      query: async input => {
        queries.push(String((input['variables'] as Record<string, unknown>)['query']));
        return {
          data: { shopifyqlQuery: { tableData: { columns: [], rows: [] }, parseErrors: [] } },
          extensions: {},
        };
      },
    });
    const inputs = [
      { connectionId: connection.connectionId, operation: 'product_performance', period: { kind: 'preset', value: 'last_month' } },
      { connectionId: connection.connectionId, operation: 'customer_acquisition', granularity: 'month', period: { kind: 'preset', value: 'last_month' } },
      { connectionId: connection.connectionId, operation: 'inventory_position', period: { kind: 'range', since: '-30d', until: 'today' } },
      { connectionId: connection.connectionId, operation: 'payments_summary', period: { kind: 'preset', value: 'last_month' } },
      { connectionId: connection.connectionId, operation: 'payments_by_method', period: { kind: 'preset', value: 'last_month' } },
    ];
    for (const input of inputs) await service.analytics(ShopifyAnalyticsArgsSchema.parse(input), context);
    assert.deepEqual(queries.map(query => query.split('\n')[0]), [
      'FROM sales', 'FROM customers', 'FROM inventory_by_location', 'FROM payments', 'FROM payments',
    ]);
    assert.equal(queries.some(query => /rawQuery|DROP TABLE/i.test(query)), false);
  });

  it('treats ShopifyQL parse errors as a bad request instead of returning partial data', async () => {
    const service = buildService({
      query: async () => ({
        data: { shopifyqlQuery: { tableData: null, parseErrors: ['Unknown metric'] } },
        extensions: {},
      }),
    });

    await assert.rejects(
      service.analytics({
        connectionId: connection.connectionId,
        operation: 'sales_summary',
        metrics: ['total_sales'],
        period: { kind: 'preset', value: 'last_month' },
      }, context),
      (error: unknown) => error instanceof ShopifyServiceError && error.code === 'bad_args',
    );
  });

  it('reports attribution as pending until Shopify marks customerJourneySummary ready', async () => {
    const service = buildService({
      query: async () => ({
        data: {
          order: {
            id: 'gid://shopify/Order/1',
            name: '#1001',
            createdAt: '2026-07-01T00:00:00.000Z',
            sourceName: 'web',
            app: { name: 'Online Store' },
            customerJourneySummary: { ready: false },
          },
        },
        extensions: {},
      }),
    });

    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order_attribution',
      orderId: 'gid://shopify/Order/1',
      includeHistorical: false,
    }, context);

    assert.equal(result.status, 'pending');
    assert.match(result.message, /preparing/i);
  });

  it('never requests protected customer contact fields and rejects includeContact input', async () => {
    const queries: string[] = [];
    const service = buildService({
      query: async input => {
        queries.push(String(input['query']));
        return { data: { customer: { id: 'gid://shopify/Customer/1', displayName: 'A' } }, extensions: {} };
      },
    });

    await service.customers({
      connectionId: connection.connectionId,
      operation: 'get_customer',
      customerId: 'gid://shopify/Customer/1',
    }, context);
    assert.doesNotMatch(queries[0]!, /displayName|firstName|lastName|\bemail\b|\bphone\b|verifiedEmail/);
    const parsed = ShopifyCustomersArgsSchema.safeParse({
      connectionId: connection.connectionId,
      operation: 'get_customer',
      customerId: 'gid://shopify/Customer/1',
      includeContact: true,
    });
    assert.equal(parsed.success, false);
  });

  it('refreshes once on 401 and retries with the newly resolved token', async () => {
    const resolveInputs: Array<Record<string, unknown>> = [];
    const tokens: string[] = [];
    let calls = 0;
    const service = new ShopifyService({
      connections: {
        resolve: async (input: Record<string, unknown>) => {
          resolveInputs.push(input);
          return { ...connection, accessToken: input['forceRefresh'] ? 'token-v2' : 'token-v1' };
        },
        touch: async () => undefined,
      } as never,
      client: {
        query: async (input: Record<string, unknown>) => {
          tokens.push(String(input['accessToken']));
          if (++calls === 1) throw new ShopifyApiError('unauthorized', 'expired', 401);
          return {
            data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            extensions: {},
          };
        },
      } as never,
      apiVersion: '2026-07',
    });

    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'list_orders',
      first: 25,
    }, context);

    assert.equal(result.status, 'empty');
    assert.deepEqual(tokens, ['token-v1', 'token-v2']);
    assert.equal(resolveInputs[1]?.['forceRefresh'], true);
  });

  it('always applies the exact 60-day floor to non-historical lists and preserves stricter filters', async () => {
    const requiredScopes: readonly string[][] = [];
    const compiledQueries: string[] = [];
    const service = new ShopifyService({
      connections: {
        resolve: async (input: { requiredScopes: readonly string[] }) => {
          requiredScopes.push(input.requiredScopes);
          return connection;
        },
        touch: async () => undefined,
      } as never,
      client: {
        query: async (input: Record<string, unknown>) => {
          compiledQueries.push(String((input['variables'] as Record<string, unknown>)['query']));
          return {
            data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            extensions: {},
          };
        },
      } as never,
      apiVersion: '2026-07',
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    });

    await service.orders({
      connectionId: connection.connectionId,
      operation: 'list_orders',
      first: 25,
    }, context);
    await service.orders({
      connectionId: connection.connectionId,
      operation: 'list_orders',
      filters: {
        createdAtMin: '2026-07-01T17:30:00.000+05:30',
        createdAtMax: '2026-07-31T23:59:59.000-04:00',
        financialStatus: 'paid',
      },
      first: 25,
    }, context);
    await service.orders({
      connectionId: connection.connectionId,
      operation: 'list_orders',
      filters: { createdAtMin: '2026-06-03T17:30:00.000+05:30' },
      first: 25,
    }, context);
    await service.orders({
      connectionId: connection.connectionId,
      operation: 'list_orders',
      filters: { createdAtMin: '2026-06-03T11:59:59.999Z' },
      first: 25,
    }, context);

    assert.deepEqual(requiredScopes, [
      ['read_orders'],
      ['read_orders'],
      ['read_orders'],
      ['read_orders', 'read_all_orders'],
    ]);
    assert.deepEqual(compiledQueries, [
      'created_at:>=2026-06-03T12:00:00.000Z',
      'created_at:>=2026-07-01T12:00:00.000Z AND created_at:<=2026-07-31T23:59:59.000-04:00 AND financial_status:paid',
      'created_at:>=2026-06-03T12:00:00.000Z',
      'created_at:>=2026-06-03T11:59:59.999Z',
    ]);
  });

  it('marks a detailed order when its bounded line-item page is incomplete', async () => {
    const service = buildService({
      query: async () => ({
        data: {
          order: {
            id: 'gid://shopify/Order/1',
            createdAt: '2026-07-01T00:00:00.000Z',
            lineItems: { nodes: Array.from({ length: 50 }, (_, index) => ({ id: String(index) })), pageInfo: { hasNextPage: true } },
          },
        },
        extensions: {},
      }),
    });

    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order',
      orderId: 'gid://shopify/Order/1',
      includeHistorical: false,
    }, context);

    assert.equal((result.data as Record<string, unknown>)['lineItemsTruncated'], true);
  });

  it('looks up a customer-facing order name through bounded order search', async () => {
    let variables: Record<string, unknown> | undefined;
    const service = buildService({
      query: async input => {
        variables = input['variables'] as Record<string, unknown>;
        return {
          data: { orders: { nodes: [{ id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2026-07-01T00:00:00.000Z' }], pageInfo: { hasNextPage: false } } },
          extensions: {},
        };
      },
    });
    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order_by_identifier',
      name: '1001',
      includeHistorical: false,
    }, context);
    assert.equal(result.status, 'complete');
    assert.equal(variables?.['query'], 'name:"#1001" AND created_at:>=2026-06-03T12:00:00.000Z');
  });

  it('preserves a custom order-name prefix instead of forcing a hash prefix', async () => {
    const compiledQueries: string[] = [];
    const service = buildService({
      query: async input => {
        compiledQueries.push(String((input['variables'] as Record<string, unknown>)['query']));
        return {
          data: { orders: { nodes: [{ id: 'gid://shopify/Order/1', name: 'NB1075', createdAt: '2026-07-01T00:00:00.000Z' }], pageInfo: { hasNextPage: false } } },
          extensions: {},
        };
      },
    });

    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order_by_identifier',
      name: 'NB1075',
      includeHistorical: false,
    }, context);

    assert.equal(result.status, 'complete');
    assert.equal((result.data as Record<string, unknown>)['name'], 'NB1075');
    assert.deepEqual(compiledQueries, ['name:"NB1075" AND created_at:>=2026-06-03T12:00:00.000Z']);
  });

  it('falls back to an unprefixed numeric order name after an exact hash-prefixed miss', async () => {
    const compiledQueries: string[] = [];
    const service = buildService({
      query: async input => {
        const query = String((input['variables'] as Record<string, unknown>)['query']);
        compiledQueries.push(query);
        return {
          data: {
            orders: {
              nodes: query.includes('name:"1001"')
                ? [{ id: 'gid://shopify/Order/1', name: '1001', createdAt: '2026-07-01T00:00:00.000Z' }]
                : [],
              pageInfo: { hasNextPage: false },
            },
          },
          extensions: {},
        };
      },
    });

    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order_by_identifier',
      name: '1001',
      includeHistorical: false,
    }, context);

    assert.equal(result.status, 'complete');
    assert.equal((result.data as Record<string, unknown>)['name'], '1001');
    assert.deepEqual(compiledQueries, [
      'name:"#1001" AND created_at:>=2026-06-03T12:00:00.000Z',
      'name:"1001" AND created_at:>=2026-06-03T12:00:00.000Z',
    ]);
  });

  it('omits direct ID lookups older than the floor and includes the exact boundary', async () => {
    let createdAt = '2026-06-03T11:59:59.999Z';
    const service = buildService({
      resolvedConnection: { ...connection, scopes: [...connection.scopes, 'read_all_orders'] },
      query: async () => ({
        data: { order: { id: 'gid://shopify/Order/1', name: '#1001', createdAt } },
        extensions: {},
      }),
    });

    const old = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order',
      orderId: 'gid://shopify/Order/1',
      includeHistorical: false,
    }, context);
    createdAt = '2026-06-03T17:30:00.000+05:30';
    const boundary = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order',
      orderId: 'gid://shopify/Order/1',
      includeHistorical: false,
    }, context);

    assert.equal(old.status, 'empty');
    assert.equal(old.data, null);
    assert.equal(boundary.status, 'complete');
  });

  it('omits identifier lookups older than the floor after exact-name matching', async () => {
    const service = buildService({
      resolvedConnection: { ...connection, scopes: [...connection.scopes, 'read_all_orders'] },
      query: async () => ({
        data: {
          orders: {
            nodes: [{ id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2026-06-03T11:59:59.999Z' }],
            pageInfo: { hasNextPage: false },
          },
        },
        extensions: {},
      }),
    });

    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order_by_identifier',
      name: '#1001',
      includeHistorical: false,
    }, context);

    assert.equal(result.status, 'empty');
    assert.equal(result.data, null);
  });

  it('omits historical attribution and line-item detail without explicit historical access', async () => {
    const service = buildService({
      resolvedConnection: { ...connection, scopes: [...connection.scopes, 'read_all_orders'] },
      query: async input => String(input['query']).includes('DivoOrderAttribution')
        ? {
          data: {
            order: {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              createdAt: '2026-06-03T11:59:59.999Z',
              customerJourneySummary: { ready: true },
            },
          },
          extensions: {},
        }
        : {
          data: {
            order: {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              createdAt: '2026-06-03T11:59:59.999Z',
              lineItems: { nodes: [{ id: 'line-1' }], pageInfo: { hasNextPage: false } },
            },
          },
          extensions: {},
        },
    });

    const attribution = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order_attribution',
      orderId: 'gid://shopify/Order/1',
      includeHistorical: false,
    }, context);
    const lineItems = await service.orders({
      connectionId: connection.connectionId,
      operation: 'list_order_line_items',
      orderId: 'gid://shopify/Order/1',
      first: 50,
      includeHistorical: false,
    }, context);

    assert.deepEqual([attribution.status, attribution.data], ['empty', null]);
    assert.deepEqual([lineItems.status, lineItems.data], ['empty', null]);
  });

  it('requires read_all_orders for historical direct ID and identifier lookups', async () => {
    const requiredScopes: readonly string[][] = [];
    const compiledQueries: string[] = [];
    const service = new ShopifyService({
      connections: {
        resolve: async (input: { requiredScopes: readonly string[] }) => {
          requiredScopes.push(input.requiredScopes);
          return { ...connection, scopes: [...connection.scopes, 'read_all_orders'] };
        },
        touch: async () => undefined,
      } as never,
      client: {
        query: async (input: Record<string, unknown>) => {
          const variables = input['variables'] as Record<string, unknown>;
          if (typeof variables['query'] === 'string') compiledQueries.push(variables['query']);
          return String(input['query']).includes('DivoOrderByName')
            ? {
              data: { orders: { nodes: [{ id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2020-01-01T00:00:00.000Z' }], pageInfo: { hasNextPage: false } } },
              extensions: {},
            }
            : { data: { order: { id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2020-01-01T00:00:00.000Z' } }, extensions: {} };
        },
      } as never,
      apiVersion: '2026-07',
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    });

    const byId = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order',
      orderId: 'gid://shopify/Order/1',
      includeHistorical: true,
    }, context);
    const byName = await service.orders({
      connectionId: connection.connectionId,
      operation: 'get_order_by_identifier',
      name: '1001',
      includeHistorical: true,
    }, context);

    assert.deepEqual(requiredScopes, [
      ['read_orders', 'read_all_orders'],
      ['read_orders', 'read_all_orders'],
    ]);
    assert.deepEqual(compiledQueries, ['name:"#1001"']);
    assert.equal(byId.status, 'complete');
    assert.equal(byName.status, 'complete');
  });

  it('fails closed when a non-historical direct lookup lacks a valid createdAt', async () => {
    const service = buildService({
      query: async () => ({
        data: { order: { id: 'gid://shopify/Order/1', name: '#1001' } },
        extensions: {},
      }),
    });

    await assert.rejects(
      service.orders({
        connectionId: connection.connectionId,
        operation: 'get_order',
        orderId: 'gid://shopify/Order/1',
        includeHistorical: false,
      }, context),
      (error: unknown) => error instanceof ShopifyServiceError && error.code === 'invalid_response',
    );
  });

  it('returns a usable cursor for bounded line-item pagination', async () => {
    const service = buildService({
      query: async () => ({
        data: {
          order: {
            id: 'gid://shopify/Order/1',
            name: '#1001',
            createdAt: '2026-07-01T00:00:00.000Z',
            lineItems: { nodes: [{ id: 'line-1' }], pageInfo: { hasNextPage: true, endCursor: 'next-line' } },
          },
        },
        extensions: {},
      }),
    });
    const result = await service.orders({
      connectionId: connection.connectionId,
      operation: 'list_order_line_items',
      orderId: 'gid://shopify/Order/1',
      first: 50,
      includeHistorical: false,
    }, context);
    assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: 'next-line' });
  });

  it('escapes structured search values before sending Shopify search syntax', async () => {
    let variables: Record<string, unknown> | undefined;
    const service = buildService({
      query: async input => {
        variables = input['variables'] as Record<string, unknown>;
        return { data: { customers: { nodes: [], pageInfo: { hasNextPage: false } } }, extensions: {} };
      },
    });

    await service.customers({
      connectionId: connection.connectionId,
      operation: 'search_customers',
      search: { field: 'name', value: 'A "quoted" \\ value' },
      first: 10,
    }, context);

    assert.equal(variables?.['query'], 'name:"A \\"quoted\\" \\\\ value"');
  });
});

function buildService(input: {
  query: (input: Record<string, unknown>) => Promise<{ data: any; extensions: Record<string, unknown>; requestId?: string }>;
  resolvedConnection?: typeof connection;
}) {
  return new ShopifyService({
    connections: {
      resolve: async () => input.resolvedConnection ?? connection,
      touch: async () => undefined,
    } as never,
    client: { query: input.query } as never,
    apiVersion: '2026-07',
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  });
}
