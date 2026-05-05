/**
 * Unit tests for controls.routes.ts.
 *
 *   GET /  — list admin control states (optionally scoped to a company)
 *
 * Verifies:
 *   - 200 happy path + response shape
 *   - SUPER_ADMIN can list globally (no companyId required)
 *   - COMPANY_ADMIN is auto-scoped
 *   - Company mismatch returns 403
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createControlsRoutes } from '../../src/http/admin/controls.routes.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const DEFAULT_LOCALS     = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };
const SUPER_ADMIN_LOCALS = { companyId: '', isSuperAdmin: true, userId: 'u-sa' };

async function callRoute(
  router: ReturnType<typeof createControlsRoutes>,
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
    const locals = opts.locals ?? { ...DEFAULT_LOCALS };

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

const fakeControl = {
  id:         'ctrl-1',
  controlKey: 'ai_ops_enabled',
  companyId:  'co-1',
  value:      true,
  updatedBy:  'u-1',
  updatedAt:  new Date('2025-01-01'),
};

function makePrisma(controls: typeof fakeControl[] = [fakeControl]) {
  return {
    adminControlState: {
      findMany: async () => controls,
    },
  } as any;
}

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET / (controls)', () => {
  it('returns 200 with control list', async () => {
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].controlKey, 'ai_ops_enabled');
  });

  it('returns empty list when no controls', async () => {
    const router = createControlsRoutes({ prisma: makePrisma([]), logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/');
    assert.equal(status, 200);
    assert.equal((body as any).data.length, 0);
  });

  it('SUPER_ADMIN can call without companyId (global scope)', async () => {
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/', { locals: SUPER_ADMIN_LOCALS });
    assert.equal(status, 200);
  });

  it('SUPER_ADMIN can filter by companyId via query', async () => {
    let capturedWhere: any;
    const prisma = {
      adminControlState: {
        findMany: async (args: any) => { capturedWhere = args.where; return []; },
      },
    } as any;
    const router = createControlsRoutes({ prisma, logger: noopLogger });
    await callRoute(router, 'GET', '/', {
      locals: SUPER_ADMIN_LOCALS,
      query:  { companyId: 'co-specific' },
    });
    assert.equal(capturedWhere.companyId, 'co-specific');
  });

  it('returns 403 when COMPANY_ADMIN passes a different companyId', async () => {
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/', {
      query: { companyId: 'co-other' },
    });
    assert.equal(status, 403);
  });

  it('formats updatedAt as ISO string', async () => {
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger });
    const { body } = await callRoute(router, 'GET', '/');
    const item = (body as any).data[0];
    assert.ok(typeof item.updatedAt === 'string');
    assert.ok(item.updatedAt.includes('T'));
  });
});
