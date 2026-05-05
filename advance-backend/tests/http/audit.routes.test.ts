/**
 * Unit tests for audit.routes.ts.
 *
 *   GET /logs — query audit logs for a company
 *
 * Verifies:
 *   - 200 happy path + response shape
 *   - Company scope enforcement
 *   - Optional actorId / action filters forwarded to service
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAuditRoutes } from '../../src/http/admin/audit.routes.ts';
import type { AuditService } from '../../src/application/observability/audit.service.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const DEFAULT_LOCALS    = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };
const SUPER_ADMIN_LOCALS = { companyId: '', isSuperAdmin: true, userId: 'u-sa' };

async function callRoute(
  router: ReturnType<typeof createAuditRoutes>,
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

const fakeLog = {
  id: 'log-1', actorId: 'u-1', companyId: 'co-1',
  action: 'permission.set', outcome: 'success', metadata: null,
  createdAt: '2025-01-01T00:00:00.000Z',
};

function makeService(overrides: Partial<{ query: AuditService['query'] }> = {}): AuditService {
  return {
    record: () => {},
    query:  async () => [fakeLog],
    ...overrides,
  } as unknown as AuditService;
}

function makeRouter(overrides?: Partial<{ query: AuditService['query'] }>) {
  return createAuditRoutes({ auditService: makeService(overrides), logger: noopLogger });
}

// ─── GET /logs ────────────────────────────────────────────────────────────────

describe('GET /logs', () => {
  it('returns 200 with log list', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/logs');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].id, 'log-1');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/logs', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });

  it('returns 200 when SUPER_ADMIN provides companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/logs', {
      locals: SUPER_ADMIN_LOCALS,
      query:  { companyId: 'co-super' },
    });
    assert.equal(status, 200);
  });

  it('returns 403 when company mismatch', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/logs', {
      query: { companyId: 'different-company' },
    });
    assert.equal(status, 403);
  });

  it('forwards actorId filter to service', async () => {
    let capturedInput: any;
    const router = createAuditRoutes({
      auditService: makeService({ query: async (input) => { capturedInput = input; return []; } }),
      logger: noopLogger,
    });
    await callRoute(router, 'GET', '/logs', { query: { actorId: 'u-actor' } });
    assert.equal(capturedInput.actorId, 'u-actor');
  });

  it('forwards action filter to service', async () => {
    let capturedInput: any;
    const router = createAuditRoutes({
      auditService: makeService({ query: async (input) => { capturedInput = input; return []; } }),
      logger: noopLogger,
    });
    await callRoute(router, 'GET', '/logs', { query: { action: 'permission.set' } });
    assert.equal(capturedInput.action, 'permission.set');
  });

  it('omits actorId from query when not provided', async () => {
    let capturedInput: any;
    const router = createAuditRoutes({
      auditService: makeService({ query: async (input) => { capturedInput = input; return []; } }),
      logger: noopLogger,
    });
    await callRoute(router, 'GET', '/logs');
    assert.equal('actorId' in capturedInput, false);
  });

  it('respects limit query param', async () => {
    let capturedInput: any;
    const router = createAuditRoutes({
      auditService: makeService({ query: async (input) => { capturedInput = input; return []; } }),
      logger: noopLogger,
    });
    await callRoute(router, 'GET', '/logs', { query: { limit: '25' } });
    assert.equal(capturedInput.limit, 25);
  });
});
