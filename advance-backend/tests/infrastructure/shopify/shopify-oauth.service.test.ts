import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShopifyOAuthError, ShopifyOAuthService } from '../../../src/infrastructure/shopify/shopify-oauth.service';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const SCOPES = ['read_reports', 'read_orders', 'read_customers'] as const;

function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    scope: SCOPES.join(','),
    expires_in: 3_600,
    refresh_token_expires_in: 7_776_000,
    ...overrides,
  };
}

function clientCredentialsBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-1',
    scope: SCOPES.join(','),
    expires_in: 86_399,
    ...overrides,
  };
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function service(fetchImpl: typeof fetch = async () => response(tokenBody())) {
  return new ShopifyOAuthService({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://app.example.test/api/shopify/auth/callback',
    scopes: SCOPES,
    timeoutMs: 2_000,
    maxRetries: 1,
    maxCallbackSkewSeconds: 300,
    fetchImpl,
    now: () => NOW,
  });
}

function signedCallback(values: Record<string, string>) {
  const params = new URLSearchParams(values);
  const message = [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  params.set('hmac', createHmac('sha256', 'client-secret').update(message).digest('hex'));
  return params;
}

describe('ShopifyOAuthService', () => {
  it('builds a canonical authorize URL and signs/verifies the state cookie', () => {
    const oauth = service();
    const authorize = new URL(oauth.getAuthorizeUrl({ shop: 'Demo-Store', state: 'opaque-state' }));

    assert.equal(authorize.origin, 'https://demo-store.myshopify.com');
    assert.equal(authorize.pathname, '/admin/oauth/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'client-id');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://app.example.test/api/shopify/auth/callback');
    assert.equal(authorize.searchParams.get('scope'), SCOPES.join(','));
    assert.equal(authorize.searchParams.get('state'), 'opaque-state');

    const cookie = oauth.createStateCookie('opaque-state');
    assert.equal(oauth.unwrapSignedState(cookie), 'opaque-state');
    assert.equal(oauth.unwrapSignedState(`${cookie}tampered`), null);
    assert.equal(oauth.verifyStateCookie(cookie, 'opaque-state'), true);
    assert.equal(oauth.verifyStateCookie(cookie, 'different-state'), false);
    assert.equal(oauth.verifyStateCookie(`${cookie}tampered`, 'opaque-state'), false);
  });

  it('rejects invalid shop input before constructing an OAuth URL', () => {
    assert.throws(
      () => service().getAuthorizeUrl({ shop: 'https://demo-store.myshopify.com/admin', state: 'state' }),
      (error: unknown) => error instanceof ShopifyOAuthError && error.code === 'invalid_shop',
    );
  });

  it('verifies callback HMAC and timestamp, including provider-error callbacks', () => {
    const oauth = service();
    const valid = signedCallback({
      shop: 'demo-store.myshopify.com',
      state: 'opaque-state',
      code: 'authorization-code',
      timestamp: String(NOW.getTime() / 1_000),
    });
    assert.deepEqual(oauth.verifyCallback(valid), {
      shop: 'demo-store.myshopify.com',
      code: 'authorization-code',
      state: 'opaque-state',
    });

    const providerError = signedCallback({
      shop: 'demo-store.myshopify.com',
      state: 'opaque-state',
      error: 'access_denied',
      timestamp: String(NOW.getTime() / 1_000),
    });
    assert.deepEqual(oauth.verifyCallback(providerError), {
      shop: 'demo-store.myshopify.com',
      error: 'access_denied',
      state: 'opaque-state',
    });

    const tampered = new URLSearchParams(valid);
    tampered.set('state', 'changed');
    assert.throws(() => oauth.verifyCallback(tampered), /signature is invalid/);

    const stale = signedCallback({
      shop: 'demo-store.myshopify.com',
      state: 'opaque-state',
      code: 'authorization-code',
      timestamp: String(NOW.getTime() / 1_000 - 301),
    });
    assert.throws(() => oauth.verifyCallback(stale), /expired/);
  });

  it('exchanges an authorization code with expiring offline-token semantics and validates scopes', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const oauth = service(async (url, init) => {
      calls.push({ url: String(url), init });
      return response(tokenBody());
    });

    const pair = await oauth.exchangeAuthorizationCode({ shop: 'demo-store', code: 'auth-code' });
    assert.equal(pair.accessToken, 'access-1');
    assert.equal(pair.refreshToken, 'refresh-1');
    assert.equal(pair.accessTokenExpiresAt.toISOString(), '2026-08-02T13:00:00.000Z');
    assert.equal(pair.refreshTokenExpiresAt.toISOString(), '2026-10-31T12:00:00.000Z');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://demo-store.myshopify.com/admin/oauth/access_token');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.init.headers && new Headers(calls[0]?.init.headers).get('content-type'), 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body))), {
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'auth-code',
      expiring: '1',
    });

    await assert.rejects(
      () => service(async () => response(tokenBody({ scope: 'read_orders' }))).exchangeAuthorizationCode({ shop: 'demo-store', code: 'auth-code' }),
      (error: unknown) => error instanceof ShopifyOAuthError && error.code === 'scope_mismatch',
    );
    await assert.rejects(
      () => service(async () => response(tokenBody({
        scope: `${SCOPES.join(',')},read_all_orders`,
      }))).exchangeAuthorizationCode({ shop: 'demo-store', code: 'auth-code' }),
      (error: unknown) => error instanceof ShopifyOAuthError
        && error.code === 'scope_mismatch'
        && error.message.includes('unexpected: read_all_orders'),
    );
  });

  it('refreshes with the same refresh token after one transient HTTP failure', async () => {
    const calls: Array<{ body: string; signal?: AbortSignal }> = [];
    let attempt = 0;
    const oauth = service(async (_url, init) => {
      calls.push({ body: String(init.body), ...(init.signal ? { signal: init.signal } : {}) });
      attempt += 1;
      return attempt === 1
        ? response({ error: 'temporarily_unavailable' }, 503, { 'retry-after': '0' })
        : response(tokenBody({ access_token: 'access-2', refresh_token: 'refresh-2' }));
    });

    const pair = await oauth.refresh({ shop: 'demo-store.myshopify.com', refreshToken: 'refresh-1' });
    assert.equal(pair.accessToken, 'access-2');
    assert.equal(calls.length, 2);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]?.body)), {
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
    assert.equal(calls[0]?.body, calls[1]?.body, 'retries must reuse the same refresh request');
  });

  it('exchanges per-store client credentials without a refresh token and validates minimum scopes', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const oauth = service(async (url, init) => {
      calls.push({ url: String(url), body: String(init.body) });
      return response(clientCredentialsBody());
    });

    const token = await oauth.exchangeClientCredentials({
      shop: 'demo-store',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      minimumScopes: ['read_reports'],
    });

    assert.equal(token.accessToken, 'access-1');
    assert.equal(token.accessTokenExpiresAt.toISOString(), '2026-08-03T11:59:59.000Z');
    assert.deepEqual(token.scopes, [...SCOPES].sort());
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]?.body)), {
      grant_type: 'client_credentials',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });

    await assert.rejects(
      () => service(async () => response(clientCredentialsBody({ scope: 'read_orders' }))).exchangeClientCredentials({
        shop: 'demo-store',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        minimumScopes: ['read_reports'],
      }),
      (error: unknown) => error instanceof ShopifyOAuthError && error.code === 'scope_mismatch',
    );
    await assert.rejects(
      () => service(async () => response({ error: 'invalid_client' }, 400)).exchangeClientCredentials({
        shop: 'demo-store',
        clientId: 'client-id',
        clientSecret: 'rotated-secret',
      }),
      (error: unknown) => error instanceof ShopifyOAuthError && error.code === 'token_rejected',
    );
  });
});
