import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  createLarkAuthRoutes,
  encodeLarkOAuthState,
  larkOAuthNonceKey,
} from '../../src/http/lark/lark-auth.routes.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this; },
} as any;

async function callRoute(
  router: ReturnType<typeof createLarkAuthRoutes>,
  method: 'GET',
  path: string,
  opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    let body: unknown;
    const req = {
      method,
      path,
      headers: opts.headers ?? {},
      query: opts.query ?? {},
    } as unknown as Request;
    const res = {
      status: (next: number) => { status = next; return res; },
      json: (value: unknown) => { body = value; resolve({ status, body }); return res; },
      send: (value: unknown) => { body = value; resolve({ status, body }); return res; },
    } as unknown as Response;

    const layer = (router as any).stack.find(
      (item: any) => item.route?.path === path && item.route?.methods?.[method.toLowerCase()],
    );
    const handler = layer?.route?.stack?.at(-1)?.handle;
    if (!handler) return resolve({ status: 404, body: { error: 'not_found' } });
    Promise.resolve(handler(req, res, () => resolve({ status: 404, body: { error: 'next' } })))
      .catch((error) => resolve({ status: 500, body: String(error) }));
  });
}

function makeRouter(overrides: Record<string, unknown> = {}) {
  return createLarkAuthRoutes({
    larkOAuthService: {
      isConfigured: () => true,
      generateNonce: () => 'nonce-1',
      getAuthorizeUrl: (state: string) => `https://accounts.larksuite.com/authorize?state=${state}`,
      exchangeCode: async () => { throw new Error('not configured'); },
    } as any,
    connectionRepo: { upsertLarkConnection: async () => ok({ id: 'connection-1' }) } as any,
    cache: {
      get: async () => ok(null),
      set: async () => ok(undefined),
      setNx: async () => ok(true),
      del: async () => ok(undefined),
      scanDel: async () => ok(0),
    } as any,
    logger: noopLogger,
    appId: 'cli_test',
    appSecret: 'secret',
    apiBase: 'https://open.larksuite.com',
    channelIdentityRepo: {
      prepareLarkLogin: async (larkOpenId: string) => ok({
        status: 'ready',
        companyId: 'company-1',
        userId: 'user-1',
        aiRole: 'MEMBER',
        larkOpenId,
        email: 'user@example.com',
        createdUser: false,
      }),
      invalidateIdentityCache: async () => {},
    } as any,
    ...overrides,
  });
}

describe('Lark OAuth account binding', () => {
  it('does not trust caller-supplied connect headers without a matching server identity', async () => {
    const router = makeRouter();
    const response = await callRoute(router, 'GET', '/connect', {
      headers: {
        'x-company-id': 'company-victim',
        'x-user-id': 'user-victim',
        'x-lark-open-id': 'ou_victim',
        'x-lark-tenant-key': 'tenant-victim',
      },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'lark_identity_mismatch' });
  });

  it('rejects a callback when OAuth returns a different Lark account', async () => {
    const state = {
      companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_expected',
      tenantKey: 'tenant-1', nonce: 'nonce-1',
    };
    let upsertCalled = false;
    const router = makeRouter({
      larkOAuthService: {
        isConfigured: () => true,
        exchangeCode: async () => ({
          accessToken: 'token', refreshToken: 'refresh', tokenType: 'Bearer', expiresIn: 3600,
          refreshTokenExpiresIn: 7200, larkOpenId: 'ou_attacker', larkUserId: 'user-lark',
          larkName: 'Attacker', larkEmail: 'attacker@example.com', larkEnName: null,
          tenantKey: 'tenant-1', scope: 'offline_access', avatarUrl: null,
        }),
      } as any,
      connectionRepo: {
        upsertLarkConnection: async () => { upsertCalled = true; return ok({ id: 'bad' }); },
      } as any,
      cache: {
        get: async (key: string) => {
          assert.equal(key, larkOAuthNonceKey('nonce-1'));
          return ok({
            companyId: state.companyId,
            userId: state.userId,
            larkOpenId: state.larkOpenId,
            tenantKey: state.tenantKey,
          });
        },
        set: async () => ok(undefined), setNx: async () => ok(true),
        del: async () => ok(undefined), scanDel: async () => ok(0),
      } as any,
    });

    const response = await callRoute(router, 'GET', '/callback', {
      query: { code: 'code-1', state: encodeLarkOAuthState(state) },
    });

    assert.equal(response.status, 400);
    assert.match(String(response.body), /Connection failed/);
    assert.equal(upsertCalled, false);
  });

  it('rejects a callback when OAuth returns a different Lark tenant', async () => {
    const state = {
      companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_expected',
      tenantKey: 'tenant-expected', nonce: 'nonce-1',
    };
    let upsertCalled = false;
    const router = makeRouter({
      larkOAuthService: {
        isConfigured: () => true,
        exchangeCode: async () => ({
          accessToken: 'token', refreshToken: 'refresh', tokenType: 'Bearer', expiresIn: 3600,
          refreshTokenExpiresIn: 7200, larkOpenId: 'ou_expected', larkUserId: 'user-lark',
          larkName: 'Expected User', larkEmail: 'expected@example.com', larkEnName: null,
          tenantKey: 'tenant-other', scope: 'offline_access', avatarUrl: null,
        }),
      } as any,
      connectionRepo: {
        upsertLarkConnection: async () => { upsertCalled = true; return ok({ id: 'bad' }); },
      } as any,
      cache: {
        get: async () => ok({
          companyId: state.companyId,
          userId: state.userId,
          larkOpenId: state.larkOpenId,
          tenantKey: state.tenantKey,
        }),
        set: async () => ok(undefined), setNx: async () => ok(true),
        del: async () => ok(undefined), scanDel: async () => ok(0),
      } as any,
    });

    const response = await callRoute(router, 'GET', '/callback', {
      query: { code: 'code-1', state: encodeLarkOAuthState(state) },
    });

    assert.equal(response.status, 400);
    assert.match(String(response.body), /Connection failed/);
    assert.equal(upsertCalled, false);
  });

  it('rejects a callback when the tenant binding became inactive', async () => {
    const state = {
      companyId: 'company-1', userId: 'user-1', larkOpenId: 'ou_expected',
      tenantKey: 'tenant-1', nonce: 'nonce-1',
    };
    let exchangeCalled = false;
    let upsertCalled = false;
    const router = makeRouter({
      larkOAuthService: {
        isConfigured: () => true,
        exchangeCode: async () => {
          exchangeCalled = true;
          throw new Error('must not exchange');
        },
      } as any,
      connectionRepo: {
        upsertLarkConnection: async () => { upsertCalled = true; return ok({ id: 'bad' }); },
      } as any,
      channelIdentityRepo: {
        prepareLarkLogin: async () => ok(null),
        invalidateIdentityCache: async () => {},
      } as any,
      cache: {
        get: async () => ok({
          companyId: state.companyId,
          userId: state.userId,
          larkOpenId: state.larkOpenId,
          tenantKey: state.tenantKey,
        }),
        set: async () => ok(undefined), setNx: async () => ok(true),
        del: async () => ok(undefined), scanDel: async () => ok(0),
      } as any,
    });

    const response = await callRoute(router, 'GET', '/callback', {
      query: { code: 'code-1', state: encodeLarkOAuthState(state) },
    });

    assert.equal(response.status, 400);
    assert.equal(exchangeCalled, false);
    assert.equal(upsertCalled, false);
  });
});
