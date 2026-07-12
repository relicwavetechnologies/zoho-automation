import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { createMemberAuthMiddleware } from '../../src/http/middleware/member-auth.middleware.ts';
import { createDesktopAuthRoutes } from '../../src/http/desktop/desktop-auth.routes.ts';
import { createGatewayRoutes } from '../../src/http/gateway/gateway.routes.ts';

const TEST_SECRET = 'test-member-secret-32-bytes-long';

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })).toString('base64url');
  const signature = createHmac('sha256', TEST_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function sessionFixture() {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    companyId: 'company-1',
    role: 'COMPANY_ADMIN',
    larkOpenId: 'ou_123',
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    user: { email: 'member@example.com' },
  };
}

function findRouteHandlers(router: unknown, path: string) {
  const layer = (router as any).stack.find((item: any) => item.route?.path === path);
  assert.ok(layer, `Expected route ${path}`);
  return layer.route.stack.map((item: any) => item.handle) as Array<(
    req: Request,
    res: Response,
    next: NextFunction,
  ) => unknown>;
}

async function callDesktopHandoff(
  router: ReturnType<typeof createDesktopAuthRoutes>,
  token: string,
): Promise<{ status: number; body: any }> {
  const handlers = findRouteHandlers(router, '/handoff');

  return new Promise((resolve) => {
    let status = 200;
    let settled = false;
    const finish = (body: unknown) => {
      if (!settled) {
        settled = true;
        resolve({ status, body });
      }
    };
    const req = {
      headers: { authorization: `Bearer ${token}` },
      body: {},
      query: {},
      params: {},
    } as unknown as Request;
    const res = {
      locals: {},
      status: (nextStatus: number) => { status = nextStatus; return res; },
      json: (body: unknown) => { finish(body); return res; },
    } as unknown as Response;
    const run = (index: number) => {
      const handler = handlers[index];
      if (!handler) return finish(undefined);
      const next: NextFunction = (error?: unknown) => {
        if (error) finish(error);
        else run(index + 1);
      };
      Promise.resolve(handler(req, res, next)).catch(finish);
    };
    run(0);
  });
}

async function callGateway(
  memberAuth: ReturnType<typeof createMemberAuthMiddleware>,
  router: ReturnType<typeof createGatewayRoutes>,
  token: string,
): Promise<{ status: number; body: any }> {
  const [handler] = findRouteHandlers(router, '/');
  assert.ok(handler);

  return new Promise((resolve) => {
    let status = 200;
    let settled = false;
    const finish = (body: unknown) => {
      if (!settled) {
        settled = true;
        resolve({ status, body });
      }
    };
    const req = {
      headers: { authorization: `Bearer ${token}` },
      body: { op: 'tools.list' },
      query: {},
      params: {},
    } as unknown as Request;
    const res = {
      locals: {},
      status: (nextStatus: number) => { status = nextStatus; return res; },
      json: (body: unknown) => { finish(body); return res; },
    } as unknown as Response;
    const next: NextFunction = (error?: unknown) => {
      if (error) return finish(error);
      Promise.resolve(handler(req, res, () => finish(undefined))).catch(finish);
    };
    Promise.resolve(memberAuth(req, res, next)).catch(finish);
  });
}

describe('member authentication uses the live company membership', () => {
  const token = buildJwt({
    sessionId: 'session-1',
    userId: 'user-1',
    companyId: 'company-1',
    role: 'COMPANY_ADMIN',
  });

  it('applies a role downgrade and membership removal to the next desktop-auth request', async () => {
    let liveRole: string | null = 'COMPANY_ADMIN';
    const handoffs: Array<{ role: string }> = [];
    const prisma = {
      memberSession: { findUnique: async () => sessionFixture() },
      adminMembership: {
        findFirst: async (args: any) => {
          assert.deepEqual(args.where, {
            userId: 'user-1',
            companyId: 'company-1',
            isActive: true,
          });
          assert.deepEqual(args.orderBy, { updatedAt: 'desc' });
          return liveRole ? { role: liveRole } : null;
        },
      },
      desktopAuthHandoff: {
        create: async ({ data }: any) => {
          handoffs.push(data);
          return data;
        },
      },
    };
    const router = createDesktopAuthRoutes({
      prisma,
      larkOAuthService: {},
      googleOAuthService: {},
      zohoTokenService: {},
      zohoConnectionRepo: {},
      larkUserAuthLinkRepo: {},
      connectionRepo: {},
      logger: noopLogger,
      env: {},
      memberJwtSecret: TEST_SECRET,
      backendPublicUrl: 'https://backend.example.com',
      sessionTtlMinutes: 480,
    } as any);

    assert.equal((await callDesktopHandoff(router, token)).status, 200);
    assert.equal(handoffs[0]?.role, 'COMPANY_ADMIN');

    liveRole = 'MEMBER';
    assert.equal((await callDesktopHandoff(router, token)).status, 200);
    assert.equal(handoffs[1]?.role, 'MEMBER');

    liveRole = null;
    const removed = await callDesktopHandoff(router, token);
    assert.equal(removed.status, 401);
    assert.equal(removed.body.error, 'Company membership is no longer active');
    assert.equal(handoffs.length, 2);
  });

  it('passes the current role to gateway dispatch and rejects a removed membership', async () => {
    let liveRole: string | null = 'COMPANY_ADMIN';
    const dispatchedRoles: string[] = [];
    const prisma = {
      memberSession: { findUnique: async () => sessionFixture() },
      adminMembership: { findFirst: async () => liveRole ? { role: liveRole } : null },
    };
    const memberAuth = createMemberAuthMiddleware({
      prisma: prisma as any,
      jwtSecret: TEST_SECRET,
      logger: noopLogger,
    });
    const gateway = createGatewayRoutes({
      dispatcher: {
        dispatch: async (_request: unknown, member: { aiRole: string }) => {
          dispatchedRoles.push(member.aiRole);
          return { ok: true, status: 'success', data: {} };
        },
      } as any,
      logger: noopLogger,
    });

    assert.equal((await callGateway(memberAuth, gateway, token)).status, 200);
    liveRole = 'MEMBER';
    assert.equal((await callGateway(memberAuth, gateway, token)).status, 200);
    assert.deepEqual(dispatchedRoles, ['COMPANY_ADMIN', 'MEMBER']);

    liveRole = null;
    const removed = await callGateway(memberAuth, gateway, token);
    assert.equal(removed.status, 401);
    assert.equal(removed.body.error, 'Company membership is no longer active');
    assert.deepEqual(dispatchedRoles, ['COMPANY_ADMIN', 'MEMBER']);
  });
});
