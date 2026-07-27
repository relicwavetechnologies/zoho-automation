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

/** Deployment defaults; per-company control rows layer over these. */
const FAKE_ENV = {
  LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore',
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
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger, env: FAKE_ENV });
    const { status, body } = await callRoute(router, 'GET', '/');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].controlKey, 'ai_ops_enabled');
  });

  it('returns empty list when no controls', async () => {
    const router = createControlsRoutes({ prisma: makePrisma([]), logger: noopLogger, env: FAKE_ENV });
    const { status, body } = await callRoute(router, 'GET', '/');
    assert.equal(status, 200);
    assert.equal((body as any).data.length, 0);
  });

  it('SUPER_ADMIN can call without companyId (global scope)', async () => {
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger, env: FAKE_ENV });
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
    const router = createControlsRoutes({ prisma, logger: noopLogger, env: FAKE_ENV });
    await callRoute(router, 'GET', '/', {
      locals: SUPER_ADMIN_LOCALS,
      query:  { companyId: 'co-specific' },
    });
    assert.equal(capturedWhere.companyId, 'co-specific');
  });

  it('returns 403 when COMPANY_ADMIN passes a different companyId', async () => {
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger, env: FAKE_ENV });
    const { status } = await callRoute(router, 'GET', '/', {
      query: { companyId: 'co-other' },
    });
    assert.equal(status, 403);
  });

  it('formats updatedAt as ISO string', async () => {
    const router = createControlsRoutes({ prisma: makePrisma(), logger: noopLogger, env: FAKE_ENV });
    const { body } = await callRoute(router, 'GET', '/');
    const item = (body as any).data[0];
    assert.ok(typeof item.updatedAt === 'string');
    assert.ok(item.updatedAt.includes('T'));
  });
});

// ─── GET /lark-untagged-policy ────────────────────────────────────────────────

describe('GET /lark-untagged-policy', () => {
  const policyPrisma = (rows: Array<Record<string, unknown>>) => ({
    adminControlState: { findMany: async () => rows },
  } as any);

  it('reports the deployment default when a company has set nothing', async () => {
    const router = createControlsRoutes({ prisma: policyPrisma([]), logger: noopLogger, env: FAKE_ENV });
    const { status, body } = await callRoute(router, 'GET', '/lark-untagged-policy');

    assert.equal(status, 200);
    const data = (body as any).data;
    // An empty control list is not an empty policy. Reporting "no rows" would
    // leave an admin unable to see the rule their people are governed by.
    assert.deepEqual(data.textRetention.value, 'retain');
    assert.deepEqual(data.textRetention.origin, 'product');
    assert.equal(data.textRetention.configurable, false);
    assert.deepEqual(data.attachments.value, 'ignore');
    assert.deepEqual(data.attachments.origin, 'deployment');
  });

  it('shows a company override and who set it', async () => {
    const router = createControlsRoutes({
      prisma: policyPrisma([{
        controlKey: 'lark.untagged.attachments',
        value: 'process',
        updatedBy: 'u-admin',
        updatedAt: new Date('2026-07-26T00:00:00.000Z'),
      }]),
      logger: noopLogger,
      env: FAKE_ENV,
    });
    const { body } = await callRoute(router, 'GET', '/lark-untagged-policy');

    const data = (body as any).data;
    assert.equal(data.attachments.value, 'process');
    assert.equal(data.attachments.origin, 'company');
    assert.equal(data.attachments.updatedBy, 'u-admin');
    assert.equal(data.attachments.updatedAt, '2026-07-26T00:00:00.000Z');
  });

  it('states the retention bounds and the receipt caveat', async () => {
    const router = createControlsRoutes({ prisma: policyPrisma([]), logger: noopLogger, env: FAKE_ENV });
    const { body } = await callRoute(router, 'GET', '/lark-untagged-policy');

    const data = (body as any).data;
    assert.equal(typeof data.retentionWindow.maxMessages, 'number');
    assert.ok(data.retentionWindow.retainedTokenBudget > 0);
    // The setting reads like a deletion guarantee and is not one; an admin
    // reading this page is exactly who needs to know that.
    assert.match(data.note, /ingress receipts/i);
  });

  it('refuses a company admin asking about another company', async () => {
    const router = createControlsRoutes({ prisma: policyPrisma([]), logger: noopLogger, env: FAKE_ENV });
    const { status } = await callRoute(router, 'GET', '/lark-untagged-policy', {
      query: { companyId: 'co-other' },
    });

    assert.equal(status, 403);
  });

  it('scopes the lookup to the asking company', async () => {
    let where: any;
    const router = createControlsRoutes({
      prisma: { adminControlState: { findMany: async (args: any) => { where = args.where; return []; } } } as any,
      logger: noopLogger,
      env: FAKE_ENV,
    });
    await callRoute(router, 'GET', '/lark-untagged-policy');

    assert.equal(where.companyId, 'co-1');
    assert.equal(where.controlKey, 'lark.untagged.attachments');
  });

  it('requires a company for a super admin with no company selected', async () => {
    const router = createControlsRoutes({ prisma: policyPrisma([]), logger: noopLogger, env: FAKE_ENV });
    const { status } = await callRoute(router, 'GET', '/lark-untagged-policy', {
      locals: SUPER_ADMIN_LOCALS,
    });

    // Unlike the control list, an effective policy is meaningless without a
    // company to resolve it for.
    assert.equal(status, 400);
  });
});

// ─── PUT /lark-untagged-policy ────────────────────────────────────────────────

describe('PUT /lark-untagged-policy', () => {
  function makeWritablePrisma() {
    const upserts: any[] = [];
    return {
      upserts,
      prisma: {
        adminControlState: {
          findMany: async () => [],
          upsert: async (args: any) => { upserts.push(args); return {}; },
        },
      } as any,
    };
  }

  it('writes the override a company asked for', async () => {
    const { prisma, upserts } = makeWritablePrisma();
    const router = createControlsRoutes({ prisma, logger: noopLogger, env: FAKE_ENV });

    const { status, body } = await callRoute(router, 'PUT', '/lark-untagged-policy', {
      body: { attachments: 'process' },
    });

    assert.equal(status, 200);
    // Without a write path, the resolver and the read view described an
    // override that only hand-written SQL could create.
    assert.equal(upserts.length, 1);
    assert.deepEqual(upserts[0].where.controlKey_companyId, {
      controlKey: 'lark.untagged.attachments',
      companyId: 'co-1',
    });
    assert.equal(upserts[0].create.value, 'process');
    assert.equal(upserts[0].update.value, 'process');
    assert.equal(upserts[0].create.updatedBy, 'u-1');
    assert.equal((body as any).data.applied['lark.untagged.attachments'], 'process');
  });

  it('rejects the removed text-retention switch', async () => {
    const { prisma, upserts } = makeWritablePrisma();
    const router = createControlsRoutes({ prisma, logger: noopLogger, env: FAKE_ENV });

    const { status } = await callRoute(router, 'PUT', '/lark-untagged-policy', {
      body: { textRetention: 'off' },
    });

    assert.equal(status, 400);
    assert.deepEqual(upserts, []);
  });

  it('rejects a value outside the two legal tokens', async () => {
    const { prisma, upserts } = makeWritablePrisma();
    const router = createControlsRoutes({ prisma, logger: noopLogger, env: FAKE_ENV });

    const { status } = await callRoute(router, 'PUT', '/lark-untagged-policy', {
      body: { attachments: 'PROCESS' },
    });

    // The resolver already refuses to read a bad row as consent; this stops the
    // bad row existing in the first place.
    assert.equal(status, 400);
    assert.deepEqual(upserts, []);
  });

  it('rejects an empty update rather than writing nothing and reporting success', async () => {
    const { prisma } = makeWritablePrisma();
    const router = createControlsRoutes({ prisma, logger: noopLogger, env: FAKE_ENV });

    const { status } = await callRoute(router, 'PUT', '/lark-untagged-policy', { body: {} });

    assert.equal(status, 400);
  });

  it('refuses to write another company"s policy', async () => {
    const { prisma, upserts } = makeWritablePrisma();
    const router = createControlsRoutes({ prisma, logger: noopLogger, env: FAKE_ENV });

    const { status } = await callRoute(router, 'PUT', '/lark-untagged-policy', {
      query: { companyId: 'co-other' },
      body: { attachments: 'process' },
    });

    assert.equal(status, 403);
    assert.deepEqual(upserts, []);
  });

  it('records who turned attachment processing on', async () => {
    const { prisma } = makeWritablePrisma();
    const audited: any[] = [];
    const router = createControlsRoutes({
      prisma, logger: noopLogger, env: FAKE_ENV,
      audit: { record: (input: unknown) => { audited.push(input); } },
    });

    await callRoute(router, 'PUT', '/lark-untagged-policy', {
      body: { attachments: 'process' },
    });

    // This setting starts moving a company's files out of Lark; the decision
    // needs an owner.
    assert.equal(audited.length, 1);
    assert.equal(audited[0].action, 'controls.lark_untagged_policy.set');
    assert.equal(audited[0].actorId, 'u-1');
    assert.equal(audited[0].companyId, 'co-1');
    assert.equal(audited[0].metadata['lark.untagged.attachments'], 'process');
  });
});
