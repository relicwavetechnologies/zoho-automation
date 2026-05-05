/**
 * Unit tests for rbac.routes.ts.
 *
 *   GET /permissions  — list permission matrix
 *
 * Verifies:
 *   - 200 happy path + response shape
 *   - Empty list when no permissions exist
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createRbacRoutes } from '../../src/http/admin/rbac.routes.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const DEFAULT_LOCALS = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };

async function callRoute(
  router: ReturnType<typeof createRbacRoutes>,
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

const fakePerm = {
  id:        'perm-1',
  role:      'COMPANY_ADMIN',
  action:    'agents.read',
  allowed:   true,
  updatedAt: new Date('2025-01-01'),
  updatedBy: 'system',
};

function makePrisma(perms: typeof fakePerm[] = [fakePerm]) {
  return {
    rbacPermission: {
      findMany: async () => perms,
    },
  } as any;
}

// ─── GET /permissions ─────────────────────────────────────────────────────────

describe('GET /permissions', () => {
  it('returns 200 with permission list', async () => {
    const router = createRbacRoutes({ prisma: makePrisma(), logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/permissions');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].id, 'perm-1');
    assert.equal(b.data[0].role, 'COMPANY_ADMIN');
    assert.equal(b.data[0].action, 'agents.read');
    assert.equal(b.data[0].allowed, true);
  });

  it('returns empty list when no permissions', async () => {
    const router = createRbacRoutes({ prisma: makePrisma([]), logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/permissions');
    assert.equal(status, 200);
    assert.equal((body as any).data.length, 0);
  });

  it('formats updatedAt as ISO string', async () => {
    const router = createRbacRoutes({ prisma: makePrisma(), logger: noopLogger });
    const { body } = await callRoute(router, 'GET', '/permissions');
    const item = (body as any).data[0];
    assert.ok(typeof item.updatedAt === 'string');
    assert.ok(item.updatedAt.includes('T'));
  });

  it('includes all required fields', async () => {
    const router = createRbacRoutes({ prisma: makePrisma(), logger: noopLogger });
    const { body } = await callRoute(router, 'GET', '/permissions');
    const item = (body as any).data[0];
    assert.ok('id' in item);
    assert.ok('role' in item);
    assert.ok('action' in item);
    assert.ok('allowed' in item);
    assert.ok('updatedAt' in item);
    assert.ok('updatedBy' in item);
  });
});
