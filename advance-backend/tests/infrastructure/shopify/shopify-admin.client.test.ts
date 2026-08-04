import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShopifyAdminClient, ShopifyApiError } from '../../../src/infrastructure/shopify/shopify-admin.client';

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: typeof fetch, maxRetries = 1, maxResponseBytes?: number) {
  return new ShopifyAdminClient({
    apiVersion: '2026-07',
    timeoutMs: 2_000,
    maxRetries,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    fetchImpl,
  });
}

describe('ShopifyAdminClient', () => {
  it('rejects mutation and subscription documents before any provider request', async () => {
    let calls = 0;
    const admin = client(async () => {
      calls += 1;
      return response({ data: {} });
    });

    for (const query of [
      'mutation UpdateOrder { orderUpdate(input: {}) { userErrors { message } } }',
      'subscription Orders { orders { id } }',
    ]) {
      await assert.rejects(
        () => admin.query({ shop: 'demo-store', accessToken: 'token', query }),
        (error: unknown) => error instanceof ShopifyApiError
          && error.code === 'read_only_violation',
      );
    }
    assert.equal(calls, 0);
  });

  it('uses the pinned GraphQL endpoint, access-token header, and JSON body', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const admin = client(async (url, init) => {
      request = { url: String(url), init };
      return response({ data: { shop: { name: 'Demo Store' } } }, 200, { 'x-request-id': 'req-1' });
    });

    const result = await admin.query<{ shop: { name: string } }>({
      shop: 'Demo-Store',
      accessToken: 'shpat-secret',
      query: 'query Shop($first: Int!) { shop { name } }',
      variables: { first: 1 },
    });

    assert.equal(request?.url, 'https://demo-store.myshopify.com/admin/api/2026-07/graphql.json');
    assert.equal(request?.init.method, 'POST');
    const headers = new Headers(request?.init.headers);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-shopify-access-token'), 'shpat-secret');
    assert.deepEqual(JSON.parse(String(request?.init.body)), {
      query: 'query Shop($first: Int!) { shop { name } }',
      variables: { first: 1 },
    });
    assert.deepEqual(result.data, { shop: { name: 'Demo Store' } });
    assert.equal(result.requestId, 'req-1');
  });

  it('rejects GraphQL errors from HTTP 200 responses and preserves detail/request id', async () => {
    const admin = client(async () => response({
      data: { shop: null },
      errors: [
        { message: 'Field requires read_reports', extensions: { code: 'ACCESS_DENIED' } },
        { message: 'Second deterministic error' },
      ],
    }, 200, { 'x-request-id': 'req-graphql' }), 0);

    await assert.rejects(
      () => admin.query({ shop: 'demo-store', accessToken: 'token', query: '{ shop { name } }' }),
      (error: unknown) => {
        assert(error instanceof ShopifyApiError);
        assert.equal(error.code, 'graphql_error');
        assert.equal(error.status, 200);
        assert.equal(error.requestId, 'req-graphql');
        assert.deepEqual(error.details, ['Field requires read_reports', 'Second deterministic error']);
        return true;
      },
    );
  });

  it('rejects GraphQL errors even when Shopify omits data entirely', async () => {
    const admin = client(async () => response({ errors: [{ message: 'Parse error' }] }), 0);

    await assert.rejects(
      () => admin.query({ shop: 'demo-store', accessToken: 'token', query: 'not graphql' }),
      (error: unknown) => error instanceof ShopifyApiError && error.code === 'graphql_error',
    );
  });

  it('classifies HTTP-200 THROTTLED errors as rate limits and retries them boundedly', async () => {
    let calls = 0;
    const admin = client(async () => {
      calls += 1;
      return calls === 1
        ? response({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] })
        : response({ data: { shop: { name: 'Demo Store' } } });
    }, 1);

    const result = await admin.query<{ shop: { name: string } }>({
      shop: 'demo-store', accessToken: 'token', query: '{ shop { name } }',
    });
    assert.equal(result.data.shop.name, 'Demo Store');
    assert.equal(calls, 2);

    const exhausted = client(async () => response({
      errors: [{ message: 'Still throttled', extensions: { code: 'THROTTLED' } }],
    }), 0);
    await assert.rejects(
      () => exhausted.query({ shop: 'demo-store', accessToken: 'token', query: '{ shop { name } }' }),
      (error: unknown) => error instanceof ShopifyApiError && error.code === 'rate_limited',
    );
  });

  it('retries a transient HTTP failure once and then returns the successful response', async () => {
    let calls = 0;
    const admin = client(async () => {
      calls += 1;
      return calls === 1
        ? response({ message: 'busy' }, 503, { 'retry-after': '0', 'x-request-id': 'req-retry-1' })
        : response({
          data: { shop: { name: 'Demo Store' } },
          extensions: { cost: { requestedQueryCost: 2, throttleStatus: { currentlyAvailable: 998, restoreRate: 100 } } },
        }, 200, { 'x-request-id': 'req-retry-2' });
    });

    const result = await admin.query<{ shop: { name: string } }>({
      shop: 'demo-store.myshopify.com',
      accessToken: 'token',
      query: '{ shop { name } }',
    });
    assert.equal(calls, 2);
    assert.equal(result.requestId, 'req-retry-2');
  });

  it('parses and retains both GraphQL and ShopifyQL cost extensions', async () => {
    const extensions = {
      cost: {
        requestedQueryCost: 12,
        throttleStatus: { currentlyAvailable: 988, restoreRate: 50 },
      },
      shopifyqlCost: {
        requestedQueryCost: 7,
        currentlyAvailable: 93,
        windowResetAt: '2026-08-02T12:01:00.000Z',
      },
    };
    const admin = client(async () => response({ data: { shop: { name: 'Demo Store' } }, extensions }), 0);

    const result = await admin.query({ shop: 'demo-store', accessToken: 'token', query: '{ shop { name } }' });
    assert.deepEqual(result.extensions, extensions);
  });

  it('does not retry authentication, authorization, or malformed-shop failures', async () => {
    let calls = 0;
    const admin = client(async () => {
      calls += 1;
      return response({ message: 'Unauthorized' }, 401, { 'x-request-id': 'req-auth' });
    }, 3);

    await assert.rejects(
      () => admin.query({ shop: 'demo-store', accessToken: 'token', query: '{ shop { name } }' }),
      (error: unknown) => error instanceof ShopifyApiError && error.code === 'unauthorized' && error.status === 401,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      () => admin.query({ shop: 'https://demo-store.myshopify.com', accessToken: 'token', query: '{}' }),
      (error: unknown) => error instanceof ShopifyApiError && error.code === 'invalid_shop',
    );
  });

  it('rejects oversized responses both with and without a content-length header', async () => {
    const body = { data: { value: 'x'.repeat(500) } };
    const declared = client(async () => response(body, 200, { 'content-length': '9999' }), 0, 100);
    const streamed = client(async () => response(body), 0, 100);

    for (const admin of [declared, streamed]) {
      await assert.rejects(
        () => admin.query({ shop: 'demo-store', accessToken: 'token', query: '{ shop { name } }' }),
        (error: unknown) => error instanceof ShopifyApiError
          && error.code === 'invalid_response'
          && /size limit/.test(error.message),
      );
    }
  });
});
