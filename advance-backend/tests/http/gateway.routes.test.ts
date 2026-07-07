/**
 * Unit tests for gateway.routes.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createGatewayRoutes } from '../../src/http/gateway/gateway.routes.ts';
import type { GatewayDispatcher } from '../../src/application/gateway/gateway-dispatcher.ts';
import type { GatewayResponse } from '../../src/application/gateway/gateway.types.ts';

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

async function callPost(
  router: ReturnType<typeof createGatewayRoutes>,
  opts: {
    body?: unknown;
    locals?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: GatewayResponse }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: GatewayResponse = { ok: false, status: 'bad_request' };

    const req = {
      method: 'POST',
      path: '/',
      params: {},
      query: {},
      body: opts.body ?? {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals: opts.locals ?? {
        companyId: 'co-1',
        userId: 'user-1',
        aiRole: 'MEMBER',
        sessionId: 'sess-1',
        email: 'user@example.com',
        larkOpenId: 'ou_123',
      },
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b as GatewayResponse; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = () => resolve({ status: 404, body: { ok: false, status: 'bad_request', error: { code: 'bad_request', message: 'not_found' } } });

    const routerAny = router as any;
    const layer = routerAny.stack?.[0];
    const handler = layer?.route?.stack?.[0]?.handle;
    if (!handler) {
      next();
      return;
    }
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}

function makeDispatcher(result: GatewayResponse): GatewayDispatcher {
  return {
    dispatch: async () => result,
  } as unknown as GatewayDispatcher;
}

describe('createGatewayRoutes', () => {
  it('returns 401 when member locals are missing', async () => {
    const router = createGatewayRoutes({
      dispatcher: makeDispatcher({ ok: true, status: 'success', data: {} }),
      logger: noopLogger,
    });

    const { status, body } = await callPost(router, {
      body: { op: 'capabilities.get' },
      locals: { companyId: 'co-1' },
    });

    assert.equal(status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'unauthorized');
  });

  it('returns 400 for malformed request body', async () => {
    const router = createGatewayRoutes({
      dispatcher: makeDispatcher({ ok: true, status: 'success', data: {} }),
      logger: noopLogger,
    });

    const { status, body } = await callPost(router, {
      body: { departmentId: 'dept-1' },
    });

    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'bad_request');
  });

  it('returns dispatcher result for valid request', async () => {
    const expected: GatewayResponse = {
      ok: true,
      status: 'success',
      data: { tools: [] },
    };
    const router = createGatewayRoutes({
      dispatcher: makeDispatcher(expected),
      logger: noopLogger,
    });

    const { status, body } = await callPost(router, {
      body: { op: 'tools.list' },
    });

    assert.equal(status, 200);
    assert.deepEqual(body, expected);
  });

  it('returns 500 when dispatcher throws', async () => {
    const router = createGatewayRoutes({
      dispatcher: {
        dispatch: async () => { throw new Error('boom'); },
      } as unknown as GatewayDispatcher,
      logger: noopLogger,
    });

    const { status, body } = await callPost(router, {
      body: { op: 'tools.list' },
    });

    assert.equal(status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'tool_error');
  });
});
