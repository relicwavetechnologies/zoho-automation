import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { createMemberAuthMiddleware } from '../../src/http/middleware/member-auth.middleware.ts';
import { createDesktopAuthRoutes } from '../../src/http/desktop/desktop-auth.routes.ts';
import { createGatewayRoutes } from '../../src/http/gateway/gateway.routes.ts';
import { issuePiRuntimeLease } from '../../src/application/runtime/pi-runtime-lease.ts';

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
    larkTenantKey: 'tenant-1',
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

async function callDesktopRoute(
  router: ReturnType<typeof createDesktopAuthRoutes>,
  path: string,
  token: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: any }> {
  const handlers = findRouteHandlers(router, path);

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
      method: options.method ?? 'GET',
      path,
      headers: { authorization: `Bearer ${token}` },
      body: options.body ?? {},
      query: {},
      params: options.params ?? {},
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

function callDesktopHandoff(
  router: ReturnType<typeof createDesktopAuthRoutes>,
  token: string,
): Promise<{ status: number; body: any }> {
  return callDesktopRoute(router, '/handoff', token, { method: 'POST' });
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
      body: {
        op: 'tools.list',
        execution: {
          version: 1,
          threadId: 'lark:chat-1',
          runId: 'run-1',
          actionId: 'action-1',
        },
      },
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

  it('retries transient authentication-store failures before dispatching', async () => {
    let sessionAttempts = 0;
    const prisma = {
      memberSession: {
        findUnique: async () => {
          sessionAttempts += 1;
          if (sessionAttempts < 3) throw new Error('transient database error');
          return sessionFixture();
        },
      },
      adminMembership: { findFirst: async () => ({ role: 'MEMBER' }) },
    };
    const memberAuth = createMemberAuthMiddleware({
      prisma: prisma as any,
      jwtSecret: TEST_SECRET,
      logger: noopLogger,
    });
    const gateway = createGatewayRoutes({
      dispatcher: {
        dispatch: async () => ({ ok: true, status: 'success', data: {} }),
      } as any,
      logger: noopLogger,
    });

    const result = await callGateway(memberAuth, gateway, token);

    assert.equal(result.status, 200);
    assert.equal(sessionAttempts, 3);
  });

  it('returns a clear temporary-unavailable error after three authentication retries', async () => {
    let sessionAttempts = 0;
    const prisma = {
      memberSession: {
        findUnique: async () => {
          sessionAttempts += 1;
          throw new Error('database unavailable');
        },
      },
      adminMembership: { findFirst: async () => ({ role: 'MEMBER' }) },
    };
    const memberAuth = createMemberAuthMiddleware({
      prisma: prisma as any,
      jwtSecret: TEST_SECRET,
      logger: noopLogger,
    });
    const gateway = createGatewayRoutes({
      dispatcher: {
        dispatch: async () => assert.fail('Unavailable authentication must not dispatch'),
      } as any,
      logger: noopLogger,
    });

    const result = await callGateway(memberAuth, gateway, token);

    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'Authentication service temporarily unavailable. Please retry.');
    assert.equal(sessionAttempts, 4);
  });

  it('accepts only a complete backend-signed Lark runtime lease', async () => {
    const dispatchedChannels: string[] = [];
    const dispatchedTenantKeys: Array<string | null | undefined> = [];
    const prisma = {
      memberSession: { findUnique: async () => sessionFixture() },
      adminMembership: { findFirst: async () => ({ role: 'MEMBER' }) },
    };
    const memberAuth = createMemberAuthMiddleware({
      prisma: prisma as any,
      jwtSecret: TEST_SECRET,
      logger: noopLogger,
      allowPiRuntimeLease: () => true,
    });
    const gateway = createGatewayRoutes({
      dispatcher: {
        dispatch: async (
          _request: unknown,
          member: { channel?: string; larkTenantKey?: string | null },
        ) => {
          dispatchedChannels.push(member.channel ?? '');
          dispatchedTenantKeys.push(member.larkTenantKey);
          return { ok: true, status: 'success', data: {} };
        },
      } as any,
      logger: noopLogger,
    });
    const lease = issuePiRuntimeLease({
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      role: 'COMPANY_ADMIN',
      instanceId: 'pi-local-1',
      threadId: 'lark:chat-1',
    }, TEST_SECRET);

    assert.equal((await callGateway(memberAuth, gateway, lease)).status, 200);
    assert.deepEqual(dispatchedChannels, ['lark']);
    assert.deepEqual(dispatchedTenantKeys, ['tenant-1']);

    const incompleteLease = buildJwt({
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      channel: 'lark',
    });
    const rejected = await callGateway(memberAuth, gateway, incompleteLease);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error, 'Invalid Pi runtime lease');
    assert.deepEqual(dispatchedChannels, ['lark']);
    assert.deepEqual(dispatchedTenantKeys, ['tenant-1']);
  });

  it('rejects a complete runtime lease on member routes unless explicitly allowed', async () => {
    const prisma = {
      memberSession: { findUnique: async () => sessionFixture() },
      adminMembership: { findFirst: async () => ({ role: 'MEMBER' }) },
    };
    const memberAuth = createMemberAuthMiddleware({
      prisma: prisma as any,
      jwtSecret: TEST_SECRET,
      logger: noopLogger,
    });
    const gateway = createGatewayRoutes({
      dispatcher: {
        dispatch: async () => {
          assert.fail('A default-denied runtime lease must not reach the route');
        },
      } as any,
      logger: noopLogger,
    });
    const lease = issuePiRuntimeLease({
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      instanceId: 'pi-local-1',
      threadId: 'lark:chat-1',
    }, TEST_SECRET);

    const rejected = await callGateway(memberAuth, gateway, lease);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error, 'Pi runtime lease is not allowed for this route');
  });

  it('rejects a runtime lease on a direct desktop connection-grant mutation', async () => {
    const prisma = {
      memberSession: { findUnique: async () => sessionFixture() },
      adminMembership: { findFirst: async () => ({ role: 'COMPANY_ADMIN' }) },
      user: { findUnique: async () => ({ id: 'user-1', email: 'member@example.com', name: 'Member' }) },
      department: { findMany: async () => [] },
    };
    const connectionRepo = {
      listAccessibleLarkConnections: async () => ({ ok: true, value: [] }),
      listAccessibleGoogleConnections: async () => ({ ok: true, value: [] }),
    };
    const router = createDesktopAuthRoutes({
      prisma,
      larkOAuthService: {},
      googleOAuthService: {},
      zohoTokenService: {},
      zohoConnectionRepo: {},
      larkUserAuthLinkRepo: {},
      connectionRepo,
      logger: noopLogger,
      env: {},
      memberJwtSecret: TEST_SECRET,
      backendPublicUrl: 'https://backend.example.com',
      sessionTtlMinutes: 480,
    } as any);
    const lease = issuePiRuntimeLease({
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      instanceId: 'pi-local-1',
      threadId: 'lark:chat-1',
    }, TEST_SECRET);

    const allowed = await callDesktopRoute(router, '/me', lease);
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body.data.runtime, {
      channel: 'lark',
      instanceId: 'pi-local-1',
      threadId: 'lark:chat-1',
      // Present but null: this lease was issued without a department, and the
      // container needs to see that rather than infer one.
      departmentId: null,
    });

    const rejected = await callDesktopRoute(
      router,
      '/lark/connections/:connectionId/grants',
      lease,
      {
        method: 'POST',
        params: { connectionId: 'connection-1' },
        body: {
          granteeType: 'company',
          granteeId: 'company-1',
          access: 'admin',
        },
      },
    );
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error, 'Pi runtime lease is not allowed for this route');
  });
});

describe('member session renewal', () => {
  const TTL_MINUTES = 7 * 24 * 60;
  const ttlMs = TTL_MINUTES * 60_000;

  /** A session with `remaining` left on the clock, and a spy on its renewal. */
  function harness(remainingMs: number) {
    const renewals: Array<{ sessionId: string; expiresAt: Date }> = [];
    const prisma = {
      memberSession: {
        findUnique: async () => ({
          ...sessionFixture(),
          expiresAt: new Date(Date.now() + remainingMs),
        }),
        update: async ({ where, data }: any) => {
          renewals.push({ sessionId: where.sessionId, expiresAt: data.expiresAt });
          return {};
        },
      },
      adminMembership: { findFirst: async () => ({ role: 'MEMBER' }) },
    };
    return { prisma, renewals };
  }

  async function run(
    middleware: ReturnType<typeof createMemberAuthMiddleware>,
    token: string,
  ): Promise<number> {
    return new Promise((resolve) => {
      let status = 200;
      const req = { headers: { authorization: `Bearer ${token}` }, path: '/me', method: 'GET' } as unknown as Request;
      const res = {
        locals: {},
        status: (s: number) => { status = s; return res; },
        json: () => { resolve(status); return res; },
      } as unknown as Response;
      void middleware(req, res, () => resolve(status));
    });
  }

  const token = buildJwt({ sessionId: 'session-1', userId: 'user-1', companyId: 'company-1' });

  it('leaves a fresh session alone', async () => {
    const { prisma, renewals } = harness(ttlMs * 0.9);
    await run(createMemberAuthMiddleware({ prisma, jwtSecret: TEST_SECRET, logger: noopLogger, sessionTtlMinutes: TTL_MINUTES } as any), token);
    // Renewing on every request would be a database write per call for nothing.
    assert.equal(renewals.length, 0);
  });

  it('extends a session past halfway, so an active person is never logged out', async () => {
    const { prisma, renewals } = harness(ttlMs * 0.2);
    await run(createMemberAuthMiddleware({ prisma, jwtSecret: TEST_SECRET, logger: noopLogger, sessionTtlMinutes: TTL_MINUTES } as any), token);
    await new Promise(r => setImmediate(r));

    assert.equal(renewals.length, 1);
    assert.equal(renewals[0]?.sessionId, 'session-1');
    const extendedBy = renewals[0]!.expiresAt.getTime() - Date.now();
    assert.ok(extendedBy > ttlMs * 0.99, `expected a full term, got ${extendedBy}ms`);
  });

  it('does not let a Pi runtime lease keep its owner signed in', async () => {
    const { prisma, renewals } = harness(ttlMs * 0.2);
    const lease = issuePiRuntimeLease({
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      role: 'MEMBER',
      instanceId: 'pi-1',
      threadId: 'lark:chat-1:user-1',
      ttlSeconds: 3_600,
    }, TEST_SECRET);

    await run(createMemberAuthMiddleware({
      prisma,
      jwtSecret: TEST_SECRET,
      logger: noopLogger,
      sessionTtlMinutes: TTL_MINUTES,
      allowPiRuntimeLease: () => true,
    } as any), lease);
    await new Promise(r => setImmediate(r));

    // The token is held by a container. A long-running agent must not be able
    // to hold its owner's sign-in open on its own — only their traffic renews.
    assert.equal(renewals.length, 0);
  });

  it('serves the request even when renewal fails', async () => {
    const { prisma } = harness(ttlMs * 0.2);
    // Throws synchronously, which a trailing .catch() alone would not contain.
    prisma.memberSession.update = (() => { throw new Error('db down'); }) as any;

    const status = await run(
      createMemberAuthMiddleware({ prisma, jwtSecret: TEST_SECRET, logger: noopLogger, sessionTtlMinutes: TTL_MINUTES } as any),
      token,
    );

    assert.equal(status, 200);
  });
});
