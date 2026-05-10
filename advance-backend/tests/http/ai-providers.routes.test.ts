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
const UPDATED_AT = new Date('2026-05-10T08:00:00.000Z');

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
      GOOGLE_GENERATIVE_AI_API_KEY: 'gemini-key',
      GEMINI_API_KEY: '',
      ...envOverrides,
    } as any,
    logger: noopLogger,
  });
}

describe('GET /status (ai-providers)', () => {
  it('returns provider status without exposing the Gateway API key', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/status');
    assert.equal(status, 200);

    const response = body as any;
    assert.equal(response.success, true);
    assert.equal(response.data.providers.openai.connected, true);
    assert.equal(response.data.providers.google.connected, true);
    assert.equal(response.data.providers.openai.gatewayUrl, 'https://gateway.example.com');
    assert.equal(JSON.stringify(response).includes('gatewayApiKey'), false);
    assert.equal(JSON.stringify(response).includes('gw-secret'), false);
  });

  it('requires super admin access', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/status', {
      locals: { companyId: COMPANY_ID, isSuperAdmin: false, userId: 'u-1' },
    });
    assert.equal(status, 403);
  });
});

describe('POST /openai/connect (ai-providers)', () => {
  it('stores an encrypted key and normalized Gateway URL', async () => {
    let capturedArgs: any;
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

    const { status, body } = await callRoute(makeRouter(prisma), 'POST', '/openai/connect', {
      body: {
        companyId:           COMPANY_ID,
        apiKey:              'sk-gateway-test',
        gatewayUrl:          'https://gateway.example.com///',
        dedicatedAccountId:  ' acct-trim ',
      },
    });

    assert.equal(status, 201);
    assert.equal((body as any).data.gatewayUrl, 'https://gateway.example.com');
    assert.equal(capturedArgs.data.gatewayUrl, 'https://gateway.example.com');
    assert.equal(capturedArgs.data.gatewayDedicatedAccountId, 'acct-trim');
    assert.notEqual(capturedArgs.data.gatewayApiKey, 'sk-gateway-test');
    assert.equal(decryptToken(capturedArgs.data.gatewayApiKey, ENCRYPTION_KEY), 'sk-gateway-test');
  });
});

describe('DELETE /openai/disconnect (ai-providers)', () => {
  it('clears stored Gateway credentials', async () => {
    let capturedArgs: any;
    const prisma = makePrisma({
      update: async (args) => {
        capturedArgs = args;
        return { id: COMPANY_ID, updatedAt: UPDATED_AT };
      },
    });

    const { status, body } = await callRoute(makeRouter(prisma), 'DELETE', '/openai/disconnect', {
      body: { companyId: COMPANY_ID },
    });

    assert.equal(status, 200);
    assert.equal((body as any).data.connected, false);
    assert.equal(capturedArgs.data.gatewayApiKey, null);
    assert.equal(capturedArgs.data.gatewayUrl, null);
    assert.equal(capturedArgs.data.gatewayDedicatedAccountId, null);
  });
});

describe('POST /openai/test (ai-providers)', () => {
  it('calls the Gateway dedicated status endpoint with the decrypted key', async () => {
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ dedicated: true }), { status: 200 });
    };

    const { status, body } = await callRoute(makeRouter(), 'POST', '/openai/test', {
      body: { companyId: COMPANY_ID },
    });

    assert.equal(status, 200);
    assert.equal((body as any).data.ok, true);
    assert.equal(capturedUrl, 'https://gateway.example.com/admin/dedicated/status/acct-1');
    assert.equal((capturedHeaders as Record<string, string>).Authorization, 'Bearer gw-secret');
    assert.equal((capturedHeaders as Record<string, string>)['x-api-key'], 'gw-secret');
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
      body: {
        companyId:          COMPANY_ID,
        defaultAiProvider:  'google',
        defaultAiModel:     'gemini-3.1-flash-lite-preview',
      },
    });

    assert.equal(status, 200);
    assert.equal((body as any).data.defaultAiProvider, 'google');
    assert.equal((body as any).data.defaultAiModel, 'gemini-3.1-flash-lite-preview');
    assert.equal(capturedArgs.data.defaultAiProvider, 'google');
  });
});
