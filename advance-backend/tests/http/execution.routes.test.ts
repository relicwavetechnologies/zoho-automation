/**
 * Unit tests for execution.routes.ts.
 *
 * Tests all three routes without spinning up a real Express server:
 *   GET /        — list recent runs
 *   GET /:id     — single run detail
 *   GET /:id/events — ordered event stream
 *
 * Verifies:
 *   - 401 when companyId not set in res.locals
 *   - 200 with correct shape on success
 *   - 404 when getRun returns null
 *   - 500 when service throws
 *   - query param forwarding (limit, offset, status, channel, phase)
 *   - isSuperAdmin forwarded from res.locals
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createExecutionRoutes } from '../../src/http/executions/execution.routes.ts';
import type { ExecutionQueryService, RunSummaryDto, RunDetailDto, EventDto } from '../../src/application/observability/execution-query.service.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

/** Call a route handler extracted from the Router stack. */
async function callRoute(
  router: ReturnType<typeof createExecutionRoutes>,
  method: 'GET' | 'PUT',
  path: string,
  opts: {
    query?:       Record<string, string>;
    locals?:      Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown; capturedLocals: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};
    const capturedLocals: Record<string, unknown> = {};

    const locals = opts.locals ?? { companyId: 'co-1', isSuperAdmin: false };

    const req = {
      method,
      path,
      params:  {},
      query:   opts.query ?? {},
      body:    {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json:   (b: unknown) => { responseBody = b; Object.assign(capturedLocals, locals); resolve({ status, body: responseBody, capturedLocals }); return res; },
    } as unknown as Response;

    const next = () => resolve({ status: 404, body: { error: 'not_found' }, capturedLocals });

    const routerAny = router as any;
    const stack: any[] = routerAny.stack ?? [];

    function matchLayer(layer: any, url: string): Record<string, string> | null {
      if (!layer.route) return null;
      const routePath: string = layer.route.path;
      const routeMethod: string = Object.keys(layer.route.methods)[0]!.toUpperCase();
      if (routeMethod !== method) return null;

      const paramNames: string[] = [];
      const pattern = routePath.replace(/:([^/]+)/g, (_: string, name: string) => {
        paramNames.push(name);
        return '([^/]+)';
      });
      const re = new RegExp(`^${pattern}$`);
      const m = url.match(re);
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
        if (handler) {
          Promise.resolve(handler(req, res, next)).catch(next);
        } else {
          next();
        }
        break;
      }
    }
    if (!matched) next();
  });
}

// ─── Fake data ────────────────────────────────────────────────────────────────

const fakeRun: RunSummaryDto = {
  id: 'run-1', status: 'success', channel: 'lark',
  entrypoint: 'lark-webhook', latestSummary: 'Done',
  errorCode: null, errorMessage: null,
  startedAt: '2025-01-01T10:00:00.000Z',
  finishedAt: '2025-01-01T10:05:00.000Z',
  durationMs: 300_000,
};

const fakeRunDetail: RunDetailDto = {
  ...fakeRun, userId: 'u-1', threadId: 'th-1', chatId: 'ch-1', agentTarget: 'supervisor',
};

const fakeEvent: EventDto = {
  id: 'ev-1', sequence: 1, phase: 'planning', eventType: 'plan_created',
  actorType: 'planner', actorKey: null, title: 'Plan created',
  summary: 'Two steps', status: 'success',
  payload: { steps: 2 },
  createdAt: '2025-01-01T10:00:00.000Z',
};

function makeService(overrides: Partial<ExecutionQueryService> = {}): ExecutionQueryService {
  return {
    listRuns:  async () => [fakeRun],
    getRun:    async () => fakeRunDetail,
    getEvents: async () => [fakeEvent],
    ...overrides,
  } as unknown as ExecutionQueryService;
}

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET /executions', () => {
  it('returns 200 with runs and total', async () => {
    const router = createExecutionRoutes({ executionQueryService: makeService(), logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.ok(Array.isArray(b.data));
    assert.equal(b.data.length, 1);
    assert.equal(b.total, 1);
  });

  it('returns 401 when companyId is missing from locals', async () => {
    const router = createExecutionRoutes({ executionQueryService: makeService(), logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/', { locals: { isSuperAdmin: false } });
    assert.equal(status, 401);
  });

  it('forwards limit and offset query params to service', async () => {
    let capturedInput: any = null;
    const svc = makeService({
      listRuns: async (input) => { capturedInput = input; return [fakeRun]; },
    });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/', { query: { limit: '10', offset: '20' } });
    assert.equal(capturedInput.limit, 10);
    assert.equal(capturedInput.offset, 20);
  });

  it('forwards status and channel query params to service', async () => {
    let capturedInput: any = null;
    const svc = makeService({
      listRuns: async (input) => { capturedInput = input; return []; },
    });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/', { query: { status: 'running', channel: 'lark' } });
    assert.equal(capturedInput.status, 'running');
    assert.equal(capturedInput.channel, 'lark');
  });

  it('forwards isSuperAdmin from res.locals', async () => {
    let capturedInput: any = null;
    const svc = makeService({
      listRuns: async (input) => { capturedInput = input; return []; },
    });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/', {
      locals: { companyId: 'co-1', isSuperAdmin: true },
    });
    assert.equal(capturedInput.isSuperAdmin, true);
  });

  it('returns 500 when service throws', async () => {
    const svc = makeService({ listRuns: async () => { throw new Error('db down'); } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/');
    assert.equal(status, 500);
  });
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

describe('GET /executions/:id', () => {
  it('returns 200 with run detail', async () => {
    const router = createExecutionRoutes({ executionQueryService: makeService(), logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/run-1');
    assert.equal(status, 200);
    assert.equal((body as any).success, true);
    assert.equal((body as any).data.id, 'run-1');
    assert.equal((body as any).data.userId, 'u-1');
  });

  it('returns 401 when companyId is missing', async () => {
    const router = createExecutionRoutes({ executionQueryService: makeService(), logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/run-1', { locals: { isSuperAdmin: false } });
    assert.equal(status, 401);
  });

  it('returns 404 when run not found', async () => {
    const svc = makeService({ getRun: async () => null });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/missing-run');
    assert.equal(status, 404);
  });

  it('passes id and companyId to service', async () => {
    let capturedInput: any = null;
    const svc = makeService({ getRun: async (input) => { capturedInput = input; return fakeRunDetail; } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/run-abc', { locals: { companyId: 'co-99', isSuperAdmin: false } });
    assert.equal(capturedInput.id, 'run-abc');
    assert.equal(capturedInput.companyId, 'co-99');
  });

  it('returns 500 when service throws', async () => {
    const svc = makeService({ getRun: async () => { throw new Error('db down'); } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/run-1');
    assert.equal(status, 500);
  });
});

// ─── GET /:id/events ──────────────────────────────────────────────────────────

describe('GET /executions/:id/events', () => {
  it('returns 200 with events and total', async () => {
    const router = createExecutionRoutes({ executionQueryService: makeService(), logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/run-1/events');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.ok(Array.isArray(b.data));
    assert.equal(b.data.length, 1);
    assert.equal(b.total, 1);
  });

  it('returns 401 when companyId is missing', async () => {
    const router = createExecutionRoutes({ executionQueryService: makeService(), logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/run-1/events', { locals: { isSuperAdmin: false } });
    assert.equal(status, 401);
  });

  it('forwards executionId and companyId to service', async () => {
    let capturedInput: any = null;
    const svc = makeService({ getEvents: async (input) => { capturedInput = input; return [fakeEvent]; } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/run-abc/events', { locals: { companyId: 'co-99', isSuperAdmin: false } });
    assert.equal(capturedInput.executionId, 'run-abc');
    assert.equal(capturedInput.companyId, 'co-99');
  });

  it('forwards phase query param to service', async () => {
    let capturedInput: any = null;
    const svc = makeService({ getEvents: async (input) => { capturedInput = input; return []; } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/run-1/events', { query: { phase: 'planning' } });
    assert.equal(capturedInput.phase, 'planning');
  });

  it('forwards limit query param', async () => {
    let capturedInput: any = null;
    const svc = makeService({ getEvents: async (input) => { capturedInput = input; return []; } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/run-1/events', { query: { limit: '25' } });
    assert.equal(capturedInput.limit, 25);
  });

  it('forwards isSuperAdmin from res.locals', async () => {
    let capturedInput: any = null;
    const svc = makeService({ getEvents: async (input) => { capturedInput = input; return []; } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    await callRoute(router, 'GET', '/run-1/events', { locals: { companyId: 'co-1', isSuperAdmin: true } });
    assert.equal(capturedInput.isSuperAdmin, true);
  });

  it('returns 500 when service throws', async () => {
    const svc = makeService({ getEvents: async () => { throw new Error('db down'); } });
    const router = createExecutionRoutes({ executionQueryService: svc, logger: noopLogger });
    const { status } = await callRoute(router, 'GET', '/run-1/events');
    assert.equal(status, 500);
  });
});
