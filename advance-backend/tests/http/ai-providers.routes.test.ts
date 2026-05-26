/**
 * Unit tests for ai-providers.routes.ts.
 *
 * Tests route handlers directly from the Express Router stack without starting
 * a server.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAiProvidersRoutes } from '../../src/http/admin/ai-providers.routes.ts';
import { decryptToken, encryptToken } from '../../src/infrastructure/shared/token.crypto.ts';

const ENCRYPTION_KEY = 'test-token-encryption-key';
const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000002';
const UPDATED_AT = new Date('2026-05-10T08:00:00.000Z');
const COMPANY_ADMIN_LOCALS = { companyId: COMPANY_ID, isSuperAdmin: false, userId: 'u-1' };

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function callRoute(
  router: ReturnType<typeof createAiProvidersRoutes>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: {
    query?:  Record<string, string>;
    body?:   Record<string, unknown>;
    locals?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};
    const locals = opts.locals ?? { companyId: COMPANY_ID, isSuperAdmin: true, userId: 'u-sa' };

    const req = {
      method,
      path,
      params:  {},
      query:   opts.query ?? {},
      body:    opts.body ?? {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json:   (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = (err?: unknown) => {
      if (err instanceof Error) {
        status = (err as Error & { status?: number }).status ?? 500;
        responseBody = { success: false, message: err.message };
      } else {
        status = 404;
        responseBody = { success: false, message: 'not_found' };
      }
      resolve({ status, body: responseBody });
    };

    const stack: any[] = (router as any).stack ?? [];
    const layer = stack.find(item => {
      if (!item.route) return false;
      const routeMethod = Object.keys(item.route.methods)[0]?.toUpperCase();
      return item.route.path === path && routeMethod === method;
    });

    const handler = layer?.route?.stack?.[0]?.handle;
    if (!handler) { next(); return; }
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}

function makePrisma(overrides: {
  findUnique?: (args: unknown) => Promise<unknown>;
  update?:     (args: unknown) => Promise<unknown>;
} = {}) {
  return {
    company: {
      findUnique: overrides.findUnique ?? (async () => ({
        id:                        COMPANY_ID,
        gatewayApiKey:             encryptToken('gw-secret', ENCRYPTION_KEY).cipherText,
        gatewayUrl:                'https://gateway.example.com',
        gatewayDedicatedAccountId: 'acct-1',
        defaultAiProvider:         'openai',
        defaultAiModel:            'gpt-4o-mini',
        updatedAt:                 UPDATED_AT,
      })),
      update: overrides.update ?? (async () => ({
        id:                        COMPANY_ID,
        gatewayUrl:                'https://gateway.example.com',
        gatewayDedicatedAccountId: 'acct-1',
        defaultAiProvider:         'openai',
        defaultAiModel:            'gpt-4o-mini',
        updatedAt:                 UPDATED_AT,
      })),
    },
  } as any;
}

function makeRouter(prisma = makePrisma(), envOverrides: Record<string, unknown> = {}) {
  return createAiProvidersRoutes({
    prisma,
    env: {
      ZOHO_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      GATEWAY_BASE_URL: 'https://gateway.example.com',
      GATEWAY_ADMIN_API_KEY: 'gw-admin-key',
      GOOGLE_GENERATIVE_AI_API_KEY: 'gemini-key',
      GEMINI_API_KEY: '',
      ...envOverrides,
    } as any,
    logger: noopLogger,
  });
}

describe('GET /status (ai-providers)', () => {
  it('returns provider status for company admins without exposing the Gateway API key', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 'active',
      tier: 'pro',
      rate_limits: {
        primary_used_percent: 12,
        secondary_used_percent: 8,
        credits_balance: 50,
        plan_type: 'Pro',
      },
      last_used_at: '2026-05-10T08:00:00.000Z',
    }), { status: 200 });

    const { status, body } = await callRoute(makeRouter(), 'GET', '/status', {
      locals: COMPANY_ADMIN_LOCALS,
    });
    assert.equal(status, 200);

    const response = body as any;
    assert.equal(response.success, true);
    assert.equal(response.data.providers.openai.connected, true);
    assert.equal(response.data.providers.google.connected, true);
    assert.equal(response.data.providers.openai.gatewayUrl, 'https://gateway.example.com');
    assert.equal(response.data.providers.openai.status, 'active');
    assert.equal(response.data.providers.openai.primaryWindowPct, 12);
    assert.equal(JSON.stringify(response).includes('gatewayApiKey'), false);
    assert.equal(JSON.stringify(response).includes('gw-secret'), false);
  });

  it('prevents company admins from reading another company', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/status', {
      locals: COMPANY_ADMIN_LOCALS,
      query:  { companyId: OTHER_COMPANY_ID },
    });
    assert.equal(status, 403);
  });
});

describe('POST /openai/connect (ai-providers)', () => {
  it('initiates Gateway dedicated authorization', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        auth_url: 'https://auth.openai.example/login',
        session_id: 'sess-1',
        dedicated_account_id: 'acct-1',
      }), { status: 200 });
    };

    const { status, body } = await callRoute(makeRouter(), 'POST', '/openai/connect', {
      locals: COMPANY_ADMIN_LOCALS,
      body:   { tier: 'pro' },
    });

    assert.equal(status, 201);
    assert.equal(capturedUrl, 'https://gateway.example.com/admin/dedicated/initiate');
    const headers = new Headers(capturedHeaders);
    assert.equal(headers.get('Authorization'), 'Bearer gw-admin-key');
    assert.equal(capturedBody.owner_app, 'divo');
    assert.equal((body as any).data.authUrl, 'https://auth.openai.example/login');
    assert.equal((body as any).data.dedicatedAccountId, 'acct-1');
  });

  it('prevents company admins from connecting another company', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/openai/connect', {
      locals: COMPANY_ADMIN_LOCALS,
      body: {
        companyId:          OTHER_COMPANY_ID,
        apiKey:             'sk-gateway-test',
        gatewayUrl:         'https://gateway.example.com',
        dedicatedAccountId: 'acct-2',
      },
    });

    assert.equal(status, 403);
  });
});

describe('POST /openai/complete (ai-providers)', () => {
  it('stores the Gateway returned API key after OAuth completion', async () => {
    let capturedArgs: any;
    let capturedBody: any;
    const prisma = makePrisma({
      update: async (args) => {
        capturedArgs = args;
        return {
          id:                        COMPANY_ID,
          gatewayUrl:                capturedArgs.data.gatewayUrl,
          gatewayDedicatedAccountId: capturedArgs.data.gatewayDedicatedAccountId,
          updatedAt:                 UPDATED_AT,
        };
      },
    });
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        dedicated_account_id: 'acct-1',
        status: 'active',
        api_key: 'divo_dk_test',
        tier: 'pro',
      }), { status: 200 });
    };

    const { status, body } = await callRoute(makeRouter(prisma), 'POST', '/openai/complete', {
      locals: COMPANY_ADMIN_LOCALS,
      body: {
        dedicatedAccountId: 'acct-1',
        callbackUrl: 'https://gateway.example.com/oauth/callback?code=abc',
      },
    });

    assert.equal(status, 200);
    assert.equal(capturedBody.dedicated_account_id, 'acct-1');
    assert.equal(capturedBody.callback_url, 'https://gateway.example.com/oauth/callback?code=abc');
    assert.equal((body as any).data.connected, true);
    assert.equal(capturedArgs.data.gatewayUrl, 'https://gateway.example.com');
    assert.equal(capturedArgs.data.gatewayDedicatedAccountId, 'acct-1');
    assert.equal(decryptToken(capturedArgs.data.gatewayApiKey, ENCRYPTION_KEY), 'divo_dk_test');
  });
});

describe('DELETE /openai/disconnect (ai-providers)', () => {
  it('clears stored Gateway credentials', async () => {
    let capturedArgs: any;
    let capturedUrl = '';
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ id: 'acct-1', status: 'disconnected', api_key_revoked: true }), { status: 200 });
    };
    const prisma = makePrisma({
      update: async (args) => {
        capturedArgs = args;
        return { id: COMPANY_ID, updatedAt: UPDATED_AT };
      },
    });

    const { status, body } = await callRoute(makeRouter(prisma), 'DELETE', '/openai/disconnect', {
      locals: COMPANY_ADMIN_LOCALS,
    });

    assert.equal(status, 200);
    assert.equal(capturedUrl, 'https://gateway.example.com/admin/dedicated/disconnect/acct-1');
    assert.equal((body as any).data.connected, false);
    assert.equal(capturedArgs.data.gatewayApiKey, null);
    assert.equal(capturedArgs.data.gatewayUrl, null);
    assert.equal(capturedArgs.data.gatewayDedicatedAccountId, null);
  });
});

describe('POST /openai/test (ai-providers)', () => {
  it('calls the Gateway dedicated test endpoint', async () => {
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ success: true, latency_ms: 42 }), { status: 200 });
    };

    const { status, body } = await callRoute(makeRouter(), 'POST', '/openai/test', {
      locals: COMPANY_ADMIN_LOCALS,
    });

    assert.equal(status, 200);
    assert.equal((body as any).data.ok, true);
    assert.equal((body as any).data.latencyMs, 42);
    assert.equal(capturedUrl, 'https://gateway.example.com/admin/dedicated/test/acct-1');
    const headers = new Headers(capturedHeaders);
    assert.equal(headers.get('Authorization'), 'Bearer gw-admin-key');
    assert.equal(headers.get('x-api-key'), 'gw-admin-key');
  });
});

describe('PUT /settings (ai-providers)', () => {
  it('updates the company default provider and model', async () => {
    let capturedArgs: any;
    const prisma = makePrisma({
      update: async (args) => {
        capturedArgs = args;
        return {
          id:                COMPANY_ID,
          defaultAiProvider: capturedArgs.data.defaultAiProvider,
          defaultAiModel:    capturedArgs.data.defaultAiModel,
          updatedAt:         UPDATED_AT,
        };
      },
    });

    const { status, body } = await callRoute(makeRouter(prisma), 'PUT', '/settings', {
      locals: COMPANY_ADMIN_LOCALS,
      body: {
        defaultAiProvider:  'google',
        defaultAiModel:     'gemini-3.1-flash-lite',
      },
    });

    assert.equal(status, 200);
    assert.equal((body as any).data.defaultAiProvider, 'google');
    assert.equal((body as any).data.defaultAiModel, 'gemini-3.1-flash-lite');
    assert.equal(capturedArgs.data.defaultAiProvider, 'google');
  });
});
