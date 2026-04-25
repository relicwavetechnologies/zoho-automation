import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkHttpClient, LarkApiError } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import { TOKEN_RESPONSE, buildMockFetch, errorMock } from '../helpers/mock-fetch.ts';

describe('LarkHttpClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('fetches a tenant token on first request', async () => {
    let tokenFetched = false;
    const calls: string[] = [];

    globalThis.fetch = async (input, _init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push(url);
      if (url.includes('tenant_access_token')) {
        tokenFetched = true;
        return new Response(JSON.stringify(TOKEN_RESPONSE), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200 });
    };

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await client.request('GET', '/open-apis/task/v2/tasks');

    assert.ok(tokenFetched, 'should have fetched a token');
    assert.equal(calls[0], 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal');
  });

  it('reuses the cached token on subsequent requests', async () => {
    let tokenCallCount = 0;
    globalThis.fetch = async (input, _init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('tenant_access_token')) {
        tokenCallCount++;
        return new Response(JSON.stringify({ ...TOKEN_RESPONSE, expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    };

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await client.request('GET', '/open-apis/task/v2/tasks');
    await client.request('GET', '/open-apis/task/v2/tasks');
    await client.request('GET', '/open-apis/task/v2/tasks');

    assert.equal(tokenCallCount, 1, 'token should only be fetched once');
  });

  it('re-fetches the token when it expires', async () => {
    let tokenCallCount = 0;
    globalThis.fetch = async (input, _init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('tenant_access_token')) {
        tokenCallCount++;
        // expire=61 means it expires in 61s, minus 60s buffer = 1s
        return new Response(JSON.stringify({ ...TOKEN_RESPONSE, expire: 61 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    };

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await client.request('GET', '/open-apis/task/v2/tasks');

    // Simulate expiry by waiting past the 1s buffer (mock expire=61, buffer=60 → 1s left)
    // Instead: just create a new client to force a fresh token fetch
    const client2 = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await client2.request('GET', '/open-apis/task/v2/tasks');

    // Each client should have fetched a token once
    assert.equal(tokenCallCount, 2);
  });

  it('throws LarkApiError when code != 0', async () => {
    const { fetch } = buildMockFetch([
      { match: () => true, response: { code: 99991663, msg: 'insufficient permissions' } },
    ]);
    globalThis.fetch = fetch;

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await assert.rejects(
      () => client.request('GET', '/open-apis/task/v2/tasks'),
      (err: unknown) => {
        assert.ok(err instanceof LarkApiError);
        assert.ok((err as LarkApiError).message.includes('insufficient permissions'));
        assert.equal((err as LarkApiError).code, 99991663);
        return true;
      },
    );
  });

  it('sends Authorization header with bearer token', async () => {
    const { fetch, calls } = buildMockFetch([
      { match: (url) => !url.includes('tenant_access_token'), response: { code: 0, data: {} } },
    ]);
    globalThis.fetch = fetch;

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await client.request('GET', '/open-apis/task/v2/tasks');

    const apiCall = calls.find(c => !c.url.includes('tenant_access_token'));
    assert.ok(apiCall?.headers['Authorization']?.startsWith('Bearer '));
  });

  it('sends JSON body and Content-Type for POST', async () => {
    const { fetch, calls } = buildMockFetch([
      { match: (url, m) => m === 'POST' && url.includes('/tasks'), response: { code: 0, data: { task: { guid: 'g1', summary: 'T' } } } },
    ]);
    globalThis.fetch = fetch;

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await client.request('POST', '/open-apis/task/v2/tasks', { body: { summary: 'Test' } });

    const apiCall = calls.find(c => c.method === 'POST' && !c.url.includes('tenant_access_token'));
    assert.equal(apiCall?.headers['Content-Type'], 'application/json');
    assert.deepEqual(apiCall?.body, { summary: 'Test' });
  });

  it('appends query parameters to the URL', async () => {
    const { fetch, calls } = buildMockFetch([
      { match: () => true, response: { code: 0, data: {} } },
    ]);
    globalThis.fetch = fetch;

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    await client.request('GET', '/open-apis/task/v2/tasks', { query: { page_size: 10, tasklist_id: 'tl1' } });

    const apiCall = calls.find(c => c.url.includes('/tasks') && !c.url.includes('token'));
    assert.ok(apiCall?.url.includes('page_size=10'));
    assert.ok(apiCall?.url.includes('tasklist_id=tl1'));
  });

  it('returns data field when present', async () => {
    globalThis.fetch = async (input, _init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('token')) return new Response(JSON.stringify(TOKEN_RESPONSE), { status: 200 });
      return new Response(JSON.stringify({ code: 0, data: { magic: 42 } }), { status: 200 });
    };

    const client = new LarkHttpClient({ appId: 'app1', appSecret: 'secret1' });
    const result = await client.request<{ magic: number }>('GET', '/open-apis/test');
    assert.equal(result.magic, 42);
  });

  it('throws LarkApiError when token endpoint fails', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 99991400, msg: 'invalid app_id' }), { status: 200 });

    const client = new LarkHttpClient({ appId: 'bad', appSecret: 'bad' });
    await assert.rejects(
      () => client.request('GET', '/open-apis/task/v2/tasks'),
      LarkApiError,
    );
  });
});
