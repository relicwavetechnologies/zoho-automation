/**
 * Unit tests for ai-models.routes.ts.
 *
 *   GET /         — list AI model target configs
 *   PUT /:key     — upsert AI model target config
 *
 * Verifies:
 *   - 200/200 happy paths for super admins and company admins
 *   - 403 when company context is missing
 *   - 400 when required fields are missing on PUT
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAiModelsRoutes } from '../../src/http/admin/ai-models.routes.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const COMPANY_ADMIN_LOCALS = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };
const SUPER_ADMIN_LOCALS   = { companyId: '', isSuperAdmin: true, userId: 'u-sa' };

async function callRoute(
  router: ReturnType<typeof createAiModelsRoutes>,
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
    const locals = opts.locals ?? { ...COMPANY_ADMIN_LOCALS };

    const req = {
      method, path,
      params:  {},
      query:   opts.query ?? {},
      body:    opts.body  ?? {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = (err?: unknown) => {
      if (err) {
        const e = err as Error & { status?: number };
        status = e.status ?? 500;
        responseBody = { success: false, message: e.message };
      }
      resolve({ status, body: responseBody });
    };

    const stack: any[] = (router as any).stack ?? [];

    function matchLayer(layer: any, url: string): Record<string, string> | null {
      if (!layer.route) return null;
      const routePath: string = layer.route.path;
      const routeMethod: string = Object.keys(layer.route.methods)[0]!.toUpperCase();
      if (routeMethod !== method) return null;
      const paramNames: string[] = [];
      const pattern = routePath.replace(/:([^/]+)/g, (_: string, name: string) => { paramNames.push(name); return '([^/]+)'; });
      const m = url.match(new RegExp(`^${pattern}$`));
      if (!m) return null;
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
      return params;
    }

    let matched = false;
    for (const layer of stack) {
      const params = matchLayer(layer, path);
      if (params !== null) {
        req.params = params as any;
        matched = true;
        const handler = layer.route.stack[0]?.handle;
        if (handler) { Promise.resolve(handler(req, res, next)).catch(next); }
        else { next(); }
        break;
      }
    }
    if (!matched) next();
  });
}

// ─── Fake data ────────────────────────────────────────────────────────────────

const fakeTarget = {
  id:                  'tgt-1',
  targetKey:           'default',
  provider:            'anthropic',
  modelId:             'claude-3-5-sonnet-20241022',
  thinkingLevel:       null,
  fastProvider:        null,
  fastModelId:         null,
  fastThinkingLevel:   null,
  xtremeProvider:      null,
  xtremeModelId:       null,
  xtremeThinkingLevel: null,
  updatedBy:           'u-sa',
  updatedAt:           new Date('2025-01-01'),
};

function makePrisma(overrides: { findMany?: any; upsert?: any } = {}) {
  return {
    aiModelTargetConfig: {
      findMany: overrides.findMany ?? (async () => [fakeTarget]),
      upsert:   overrides.upsert  ?? (async () => fakeTarget),
    },
  } as any;
}

function makeRouter(overrides?: { findMany?: any; upsert?: any }) {
  return createAiModelsRoutes({ prisma: makePrisma(overrides), logger: noopLogger });
}

const validPutBody = {
  provider: 'anthropic',
  modelId:  'claude-3-5-sonnet-20241022',
};

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET / (ai-models)', () => {
  it('returns 200 with target list for SUPER_ADMIN', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].targetKey, 'default');
    assert.equal(b.data[0].provider, 'anthropic');
  });

  it('returns 200 with target list for COMPANY_ADMIN', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/', {
      locals: COMPANY_ADMIN_LOCALS,
    });
    assert.equal(status, 200);
    assert.equal((body as any).data[0].targetKey, 'default');
  });

  it('returns 403 when company context is missing for non-super-admin', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/', {
      locals: { companyId: '', isSuperAdmin: false, userId: 'u-1' },
    });
    assert.equal(status, 403);
  });

  it('formats updatedAt as ISO string', async () => {
    const { body } = await callRoute(makeRouter(), 'GET', '/', { locals: SUPER_ADMIN_LOCALS });
    const item = (body as any).data[0];
    assert.ok(typeof item.updatedAt === 'string');
    assert.ok(item.updatedAt.includes('T'));
  });

  it('returns empty list when no targets', async () => {
    const router = makeRouter({ findMany: async () => [] });
    const { body } = await callRoute(router, 'GET', '/', { locals: SUPER_ADMIN_LOCALS });
    assert.equal((body as any).data.length, 0);
  });
});

// ─── PUT /:targetKey ──────────────────────────────────────────────────────────

describe('PUT /:targetKey (ai-models)', () => {
  it('returns 200 on successful upsert for SUPER_ADMIN', async () => {
    const { status, body } = await callRoute(makeRouter(), 'PUT', '/default', {
      locals: SUPER_ADMIN_LOCALS,
      body:   validPutBody,
    });
    assert.equal(status, 200);
    assert.equal((body as any).success, true);
    assert.equal((body as any).data.targetKey, 'default');
  });

  it('returns 200 on successful upsert for COMPANY_ADMIN', async () => {
    const { status, body } = await callRoute(makeRouter(), 'PUT', '/default', {
      locals: COMPANY_ADMIN_LOCALS,
      body:   validPutBody,
    });
    assert.equal(status, 200);
    assert.equal((body as any).success, true);
    assert.equal((body as any).data.targetKey, 'default');
  });

  it('returns 403 when company context is missing for non-super-admin', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/default', {
      locals: { companyId: '', isSuperAdmin: false, userId: 'u-1' },
      body:   validPutBody,
    });
    assert.equal(status, 403);
  });

  it('returns 400 when provider is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/default', {
      locals: SUPER_ADMIN_LOCALS,
      body:   { modelId: 'claude-3-5-sonnet' },
    });
    assert.equal(status, 400);
  });

  it('returns 400 when modelId is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/default', {
      locals: SUPER_ADMIN_LOCALS,
      body:   { provider: 'anthropic' },
    });
    assert.equal(status, 400);
  });

  it('passes targetKey from URL to upsert', async () => {
    let capturedWhere: any;
    const router = makeRouter({
      upsert: async (args: any) => { capturedWhere = args.where; return fakeTarget; },
    });
    await callRoute(router, 'PUT', '/fast-model', {
      locals: SUPER_ADMIN_LOCALS,
      body:   validPutBody,
    });
    assert.equal(capturedWhere.targetKey, 'fast-model');
  });

  it('accepts nullable optional fields', async () => {
    let capturedUpdate: any;
    const router = makeRouter({
      upsert: async (args: any) => { capturedUpdate = args.update; return fakeTarget; },
    });
    await callRoute(router, 'PUT', '/default', {
      locals: SUPER_ADMIN_LOCALS,
      body:   { ...validPutBody, thinkingLevel: null, fastProvider: 'openai', fastModelId: 'gpt-4o' },
    });
    assert.equal(capturedUpdate.thinkingLevel, null);
    assert.equal(capturedUpdate.fastProvider, 'openai');
    assert.equal(capturedUpdate.fastModelId, 'gpt-4o');
  });
});
