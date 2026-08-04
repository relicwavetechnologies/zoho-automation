import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Request, RequestHandler, Response } from 'express';

import {
  createShopifyAuthRoutes,
} from '../../src/http/shopify/shopify-auth.routes.ts';
import { ShopifyAuthorizationService } from '../../src/application/shopify/shopify-authorization.service.ts';
import { ShopifyAdminClient } from '../../src/infrastructure/shopify/shopify-admin.client.ts';
import { ShopifyOAuthService } from '../../src/infrastructure/shopify/shopify-oauth.service.ts';
import { ok } from '../../src/shared/result.ts';

const now = new Date('2026-08-02T00:00:00.000Z');
const frontendBaseUrl = 'https://app.example.test';
const redirectUri = 'https://backend.example.test/api/shopify/auth/callback';
const clientSecret = 'shopify-client-secret';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function () { return this; },
} as any;

type AttemptFake = ReturnType<typeof makeAttempts>;

function makeAttempts() {
  const values = new Map<string, unknown>();
  let claimCount = 0;
  return {
    values,
    createShopify: async (input: any) => {
      values.set(input.state, { id: `attempt-${values.size + 1}`, ...input });
      return ok(undefined);
    },
    claimShopify: async (input: any) => {
      claimCount += 1;
      const value = values.get(input.state) as any;
      values.delete(input.state);
      return ok(value ? {
        id: value.id,
        companyId: value.companyId,
        userId: value.userId,
        shopDomain: value.shopDomain,
        requestedScopes: value.requestedScopes,
        ...(value.returnTo ? { returnTo: value.returnTo } : {}),
      } : null);
    },
    complete: async () => ok(undefined),
    fail: async () => ok(undefined),
    get claimCount() { return claimCount; },
  } as any;
}

function makeOAuth(overrides: Record<string, unknown> = {}) {
  return new ShopifyOAuthService({
    clientId: 'shopify-client-id',
    clientSecret,
    redirectUri,
    scopes: ['read_reports', 'read_orders', 'read_customers'],
    timeoutMs: 100,
    maxRetries: 0,
    maxCallbackSkewSeconds: 300,
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: 'access-token-secret',
      scope: 'read_reports,read_orders,read_customers',
      expires_in: 3_600,
      refresh_token: 'refresh-token-secret',
      refresh_token_expires_in: 7_776_000,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ...overrides,
  });
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const attempts = (overrides['attempts'] as AttemptFake | undefined) ?? makeAttempts();
  const persisted: unknown[] = [];
  const oauth = (overrides['oauth'] as ShopifyOAuthService | undefined) ?? makeOAuth();
  const adminClient = (overrides['adminClient'] as ShopifyAdminClient | undefined) ?? {
    query: async () => ({
      data: { shop: { id: 'gid://shopify/Shop/1', name: 'Demo store', myshopifyDomain: 'demo.myshopify.com' } },
      extensions: {},
    }),
  } as unknown as ShopifyAdminClient;
  const connectionRepo = (overrides['connectionRepo'] as any | undefined) ?? {
    upsertShopifyConnection: async (input: unknown) => {
      persisted.push(input);
      return ok({ id: 'connection-1' });
    },
    listManageableShopifyConnections: async () => ok([{
      connectionId: '11111111-1111-4111-8111-111111111111',
      shopDomain: 'demo.myshopify.com',
      label: 'Demo store',
      status: 'reauthorization_required',
      connectedAt: now,
    }]),
    findShopifyConnectionForReconnect: async (input: { connectionId: string }) => ok(
      input.connectionId === '11111111-1111-4111-8111-111111111111'
        ? {
            connectionId: input.connectionId,
            shopDomain: 'demo.myshopify.com',
            label: 'Demo store',
            status: 'reauthorization_required',
            connectedAt: now,
          }
        : null,
    ),
  };
  const authorization = (overrides['authorization'] as ShopifyAuthorizationService | undefined) ?? new ShopifyAuthorizationService({
    oauth,
    adminClient,
    attempts: attempts as any,
    connections: connectionRepo,
    scopes: (overrides['authorizationScopes'] as readonly string[] | undefined)
      ?? ['read_reports', 'read_orders', 'read_customers'],
    apiVersion: '2026-07',
    now: () => now,
  });
  const deps = {
    authenticate: ((_req, res, next) => {
      res.locals['userId'] = 'user-1';
      res.locals['companyId'] = 'company-1';
      res.locals['isAdmin'] = true;
      next();
    }) as RequestHandler,
    authorization,
    logger: noopLogger,
    frontendBaseUrl,
    ...(overrides['authenticate'] ? { authenticate: overrides['authenticate'] } : {}),
  };
  return { deps, cache: attempts, persisted };
}

type RouteResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  redirect?: string;
  locals: Record<string, unknown>;
};

async function callRoute(
  router: ReturnType<typeof createShopifyAuthRoutes>,
  path: string,
  options: {
    readonly query?: Record<string, string>;
    readonly headers?: Record<string, string>;
    readonly locals?: Record<string, unknown>;
    readonly params?: Record<string, string>;
  } = {},
): Promise<RouteResult> {
  const layer = (router as any).stack.find(
    (item: any) => item.route?.path === path && item.route?.methods?.get,
  );
  assert.ok(layer, `route ${path} was not registered`);
  const query = new URLSearchParams(options.query ?? {}).toString();
  const req = {
    method: 'GET',
    path,
    originalUrl: query ? `${path}?${query}` : path,
    query: options.query ?? {},
    params: options.params ?? {},
    headers: options.headers ?? {},
  } as unknown as Request;
  const locals = options.locals ?? {};
  let status = 200;
  let body: unknown;
  let redirect: string | undefined;
  const headers: Record<string, string> = {};

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve({ status, body, headers, ...(redirect ? { redirect } : {}), locals });
    };
    const res = {
      locals,
      status: (next: number) => { status = next; return res; },
      setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; return res; },
      getHeader: (name: string) => headers[name.toLowerCase()],
      json: (value: unknown) => { body = value; finish(); return res; },
      send: (value: unknown) => { body = value; finish(); return res; },
      redirect: (location: string) => { status = 302; redirect = location; finish(); return res; },
      end: () => { finish(); return res; },
    } as unknown as Response;

    const handlers = layer.route.stack.map((entry: any) => entry.handle as RequestHandler);
    const run = (index: number): void => {
      if (finished) return;
      const handler = handlers[index];
      if (!handler) { finish(); return; }
      try {
        const returned = handler(req, res, () => run(index + 1));
        if (returned && typeof (returned as Promise<unknown>).then === 'function') {
          void (returned as Promise<unknown>).catch(reject);
        }
      } catch (error) {
        reject(error);
      }
    };
    run(0);
  });
}

function stateFromConnect(response: RouteResult): { state: string; cookie: string } {
  const authorizeUrl = new URL(String((response.body as any).authorizeUrl));
  const state = authorizeUrl.searchParams.get('state');
  const cookieHeader = response.headers['set-cookie'];
  assert.ok(state);
  assert.ok(cookieHeader);
  return { state, cookie: cookieHeader.split(';', 1)[0]! };
}

function signedCallback(params: Record<string, string>): Record<string, string> {
  const canonical = Object.entries(params)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return { ...params, hmac: createHmac('sha256', clientSecret).update(canonical).digest('hex') };
}

async function beginConnect(
  router: ReturnType<typeof createShopifyAuthRoutes>,
  returnTo = '/settings/integrations?tab=shopify',
) {
  const response = await callRoute(router, '/connect', {
    query: { shop: 'demo.myshopify.com', returnTo },
  });
  assert.equal(response.status, 200);
  return { response, ...stateFromConnect(response) };
}

describe('Shopify OAuth routes', () => {
  it('lists repairable company stores and reconnects by stored connection ID', async () => {
    const { deps, cache } = makeDeps();
    const router = createShopifyAuthRoutes(deps as any);
    const listed = await callRoute(router, '/connections');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, {
      connections: [{
        connectionId: '11111111-1111-4111-8111-111111111111',
        shopDomain: 'demo.myshopify.com',
        label: 'Demo store',
        status: 'reauthorization_required',
        reconnectRequired: true,
        connectedAt: now.toISOString(),
      }],
    });

    const reconnected = await callRoute(router, '/reconnect/:connectionId', {
      params: { connectionId: '11111111-1111-4111-8111-111111111111' },
      query: { returnTo: '/settings/integrations?tab=shopify' },
    });
    assert.equal(reconnected.status, 200);
    assert.match(String((reconnected.body as any).authorizeUrl), /^https:\/\/demo\.myshopify\.com\/admin\/oauth\/authorize/);
    assert.equal(cache.values.size, 1);
  });

  it('does not reveal cross-company or unknown Shopify connection IDs during reconnect', async () => {
    const { deps, cache } = makeDeps();
    const router = createShopifyAuthRoutes(deps as any);
    const response = await callRoute(router, '/reconnect/:connectionId', {
      params: { connectionId: '22222222-2222-4222-8222-222222222222' },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'shopify_connection_not_found' });
    assert.equal(cache.values.size, 0);
  });

  it('authenticates connect, normalizes the shop, stores one-time state, and signs the browser cookie', async () => {
    let authenticated = false;
    const { deps, cache } = makeDeps({
      authenticate: ((_req, res, next) => {
        authenticated = true;
        res.locals['userId'] = 'user-1';
        res.locals['companyId'] = 'company-1';
        res.locals['isAdmin'] = true;
        next();
      }) as RequestHandler,
    });
    const router = createShopifyAuthRoutes(deps as any);
    const response = await callRoute(router, '/connect', { query: { shop: ' Demo.MyShopify.com ' } });

    assert.equal(response.status, 200);
    assert.equal(authenticated, true);
    const { state, cookie } = stateFromConnect(response);
    assert.match(String((response.body as any).authorizeUrl), /^https:\/\/demo\.myshopify\.com\/admin\/oauth\/authorize/);
    assert.match(cookie, /^divo_shopify_oauth_state=[^;]+$/);
    assert.match(response.headers['set-cookie']!, /HttpOnly/);
    assert.match(response.headers['set-cookie']!, /SameSite=Lax/);
    assert.ok(cache.values.has(state));
  });

  it('rejects company connections for non-admins and rejects cross-origin open redirects before storing state', async () => {
    const first = makeDeps({
      authenticate: ((_req, res, next) => {
        res.locals['userId'] = 'user-1';
        res.locals['companyId'] = 'company-1';
        res.locals['isAdmin'] = false;
        next();
      }) as RequestHandler,
    });
    const firstRouter = createShopifyAuthRoutes(first.deps as any);
    const companyResponse = await callRoute(firstRouter, '/connect', {
      query: { shop: 'demo.myshopify.com', linkType: 'company' },
    });
    assert.equal(companyResponse.status, 403);
    assert.equal(first.cache.values.size, 0);

    const second = makeDeps();
    const secondRouter = createShopifyAuthRoutes(second.deps as any);
    const redirectResponse = await callRoute(secondRouter, '/connect', {
      query: { shop: 'demo.myshopify.com', returnTo: 'https://evil.example.test/steal' },
    });
    assert.equal(redirectResponse.status, 400);
    assert.deepEqual(redirectResponse.body, { error: 'invalid_return_to' });
    assert.equal(second.cache.values.size, 0);
  });

  it('fails closed when durable OAuth-attempt persistence is unavailable', async () => {
    const { deps } = makeDeps({
      authorization: {
        isConfigured: () => true,
        begin: async () => { throw new Error('database unavailable'); },
      },
    });
    const router = createShopifyAuthRoutes(deps as any);
    const response = await callRoute(router, '/connect', { query: { shop: 'demo.myshopify.com' } });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'oauth_state_storage_unavailable' });
  });

  it('rejects invalid HMAC callbacks without consuming state or exchanging the code', async () => {
    let exchangeCalled = false;
    const { deps, cache } = makeDeps({
      oauth: makeOAuth({
        exchangeAuthorizationCode: async () => { exchangeCalled = true; throw new Error('must not exchange'); },
      }),
    });
    const router = createShopifyAuthRoutes(deps as any);
    const { state, cookie } = await beginConnect(router);
    const response = await callRoute(router, '/callback', {
      headers: { cookie },
      query: {
        shop: 'demo.myshopify.com', code: 'code-1', state,
        timestamp: String(now.getTime() / 1_000), hmac: '0'.repeat(64),
      },
    });

    assert.equal(response.status, 302);
    assert.match(response.redirect!, /status=error&provider=shopify/);
    assert.equal(exchangeCalled, false);
    assert.equal(cache.claimCount, 0);
  });

  it('atomically consumes state and rejects mismatched shops, provider denial, and replay', async () => {
    const { deps, cache, persisted } = makeDeps();
    const router = createShopifyAuthRoutes(deps as any);
    const first = await beginConnect(router, '/dashboard/shopify');
    const mismatch = await callRoute(router, '/callback', {
      headers: { cookie: first.cookie },
      query: signedCallback({
        shop: 'other.myshopify.com', code: 'code-1', state: first.state,
        timestamp: String(now.getTime() / 1_000),
      }),
    });
    assert.equal(mismatch.status, 302);
    assert.match(mismatch.redirect!, /status=error&provider=shopify/);
    assert.equal(cache.claimCount, 1);
    assert.equal(persisted.length, 0);

    const deniedStart = await beginConnect(router);
    const denied = await callRoute(router, '/callback', {
      headers: { cookie: deniedStart.cookie },
      query: signedCallback({
        shop: 'demo.myshopify.com', error: 'access_denied', state: deniedStart.state,
        timestamp: String(now.getTime() / 1_000),
      }),
    });
    assert.equal(denied.status, 302);
    assert.match(denied.redirect!, /status=denied&provider=shopify/);
    assert.equal(cache.claimCount, 2);
    assert.equal(persisted.length, 0);

    const replayStart = await beginConnect(router, '/dashboard/shopify');
    const callback = signedCallback({
      shop: 'demo.myshopify.com', code: 'code-1', state: replayStart.state,
      timestamp: String(now.getTime() / 1_000),
    });
    const firstCallback = await callRoute(router, '/callback', {
      headers: { cookie: replayStart.cookie }, query: callback,
    });
    const replay = await callRoute(router, '/callback', {
      headers: { cookie: replayStart.cookie }, query: callback,
    });
    assert.equal(firstCallback.redirect, 'https://app.example.test/dashboard/shopify');
    assert.match(replay.redirect!, /status=error&provider=shopify/);
    assert.equal(cache.claimCount, 4);
    assert.equal(persisted.length, 1);
  });

  it('persists the verified store and expiring token pair, then redirects only to the safe frontend origin', async () => {
    let tokenRequestBody = '';
    const { deps, persisted } = makeDeps({
      oauth: makeOAuth({
        fetchImpl: async (_url, init) => {
          tokenRequestBody = String(init?.body ?? '');
          return new Response(JSON.stringify({
            access_token: 'access-token-secret',
            scope: 'read_reports,read_orders,read_customers',
            expires_in: 3_600,
            refresh_token: 'refresh-token-secret',
            refresh_token_expires_in: 7_776_000,
          }), { status: 200 });
        },
      }),
    });
    const router = createShopifyAuthRoutes(deps as any);
    const { state, cookie } = await beginConnect(router, '/dashboard/shopify?tab=orders');
    const response = await callRoute(router, '/callback', {
      headers: { cookie },
      query: signedCallback({
        shop: 'demo.myshopify.com', code: 'authorization-code', state,
        timestamp: String(now.getTime() / 1_000),
      }),
    });

    assert.equal(response.status, 302);
    assert.equal(response.redirect, 'https://app.example.test/dashboard/shopify?tab=orders');
    assert.match(tokenRequestBody, /expiring=1/);
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], {
      companyId: 'company-1',
      ownerType: 'company',
      createdBy: 'user-1',
      shopDomain: 'demo.myshopify.com',
      shopName: 'Demo store',
      shopGraphqlId: 'gid://shopify/Shop/1',
      accessToken: 'access-token-secret',
      refreshToken: 'refresh-token-secret',
      accessTokenExpiresAt: new Date('2026-08-02T01:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-10-31T00:00:00.000Z'),
      scopes: ['read_customers', 'read_orders', 'read_reports'],
      apiVersion: '2026-07',
      authorizationAttemptId: 'attempt-1',
    });
    assert.equal(JSON.stringify(response).includes('access-token-secret'), false);
  });

  it('completes a desktop authorization with signed parameter state and no shared browser cookie', async () => {
    const { deps, persisted } = makeDeps();
    const started = await deps.authorization.begin({
      companyId: 'company-1',
      userId: 'user-1',
      shopDomain: 'demo.myshopify.com',
      stateTransport: 'signed_parameter',
    });
    const providerState = new URL(started.authorizeUrl).searchParams.get('state');
    assert.ok(providerState);
    assert.notEqual(providerState, started.state);

    const router = createShopifyAuthRoutes(deps as any);
    const response = await callRoute(router, '/callback', {
      query: signedCallback({
        shop: 'demo.myshopify.com', code: 'desktop-authorization-code', state: providerState,
        timestamp: String(now.getTime() / 1_000),
      }),
    });

    assert.equal(response.status, 302);
    assert.match(response.redirect!, /status=connected&provider=shopify/);
    assert.equal(persisted.length, 1);
  });

  it('validates callback grants against the scopes snapshotted when authorization began', async () => {
    const { deps, persisted } = makeDeps({
      authorizationScopes: ['read_reports', 'read_orders'],
      oauth: makeOAuth({
        fetchImpl: async () => new Response(JSON.stringify({
          access_token: 'access-token-secret',
          scope: 'read_reports,read_orders',
          expires_in: 3_600,
          refresh_token: 'refresh-token-secret',
          refresh_token_expires_in: 7_776_000,
        }), { status: 200 }),
      }),
    });
    const router = createShopifyAuthRoutes(deps as any);
    const { state, cookie } = await beginConnect(router, '/dashboard/shopify');
    const response = await callRoute(router, '/callback', {
      headers: { cookie },
      query: signedCallback({
        shop: 'demo.myshopify.com', code: 'authorization-code', state,
        timestamp: String(now.getTime() / 1_000),
      }),
    });

    assert.equal(response.status, 302);
    assert.equal(response.redirect, 'https://app.example.test/dashboard/shopify');
    assert.equal(persisted.length, 1);
    assert.deepEqual((persisted[0] as any).scopes, ['read_orders', 'read_reports']);
  });
});
