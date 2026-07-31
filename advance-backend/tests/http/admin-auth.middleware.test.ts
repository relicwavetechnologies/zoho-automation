/**
 * Unit tests for the admin-auth middleware.
 *
 * Tests all auth paths:
 *  - missing header → 401
 *  - x-api-key matches internalApiKey → pass, isSuperAdmin=true
 *  - Bearer <INTERNAL_API_KEY> → same
 *  - malformed JWT → 401
 *  - expired JWT → 401
 *  - valid JWT but no sessionId → 401
 *  - valid JWT, session not found → 401
 *  - valid JWT, session revoked → 401
 *  - valid JWT, session DB-expired → 401
 *  - DB throws → 500
 *  - valid JWT + valid session → next(), res.locals populated
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { createAdminAuthMiddleware } from '../../src/http/middleware/admin-auth.middleware.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-jwt-secret-32-bytes-long-xx';
const TEST_API_KEY = 'sk-internal-test-key';

function buildJwt(
  payload: Record<string, unknown>,
  secret: string,
  expOffsetSeconds?: number,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const full = expOffsetSeconds !== undefined
    ? { ...payload, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds }
    : payload;
  const payloadB64 = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', secret)
    .update(`${header}.${payloadB64}`)
    .digest('base64url');
  return `${header}.${payloadB64}.${sig}`;
}

function makeReq(opts: {
  authorization?: string;
  apiKey?: string;
  companyId?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers['authorization'] = opts.authorization;
  if (opts.apiKey)        headers['x-api-key']     = opts.apiKey;
  if (opts.companyId)     headers['x-company-id']  = opts.companyId;
  return { headers } as unknown as Request;
}

interface FakeRes {
  locals:   Record<string, unknown>;
  _status?: number;
  _body?:   unknown;
  status:   (n: number) => FakeRes;
  json:     (b: unknown) => void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    locals: {},
    status(n) { this._status = n; return this; },
    json(b)   { this._body   = b; },
  };
  return res;
}

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
};

function makeMiddleware(opts: {
  sessionResult?: unknown;
  sessionThrows?: boolean;
  withApiKey?: boolean;
}) {
  const prisma = {
    adminSession: {
      findUnique: async () => {
        if (opts.sessionThrows) throw new Error('db error');
        return opts.sessionResult ?? null;
      },
    },
  };
  return createAdminAuthMiddleware({
    prisma:        prisma as any,
    jwtSecret:     TEST_SECRET,
    logger:        noopLogger as any,
    ...(opts.withApiKey ? { internalApiKey: TEST_API_KEY } : {}),
  });
}

async function call(
  middleware: ReturnType<typeof makeMiddleware>,
  req: Request,
): Promise<{ res: FakeRes; nextCalled: boolean }> {
  const res = makeRes();
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  await middleware(req, res as unknown as Response, next);
  return { res, nextCalled };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createAdminAuthMiddleware', () => {
  describe('no credentials', () => {
    it('returns 401 when Authorization header is absent', async () => {
      const mw = makeMiddleware({});
      const { res, nextCalled } = await call(mw, makeReq({}));
      assert.equal(res._status, 401);
      assert.equal(nextCalled, false);
    });
  });

  describe('internal API key (x-api-key header)', () => {
    it('passes when x-api-key matches', async () => {
      const mw = makeMiddleware({ withApiKey: true });
      const { res, nextCalled } = await call(mw, makeReq({ apiKey: TEST_API_KEY }));
      assert.equal(nextCalled, true);
      assert.equal(res.locals['isSuperAdmin'], true);
    });

    it('sets companyId from x-company-id header', async () => {
      const mw = makeMiddleware({ withApiKey: true });
      const { res } = await call(mw, makeReq({ apiKey: TEST_API_KEY, companyId: 'co-xyz' }));
      assert.equal(res.locals['companyId'], 'co-xyz');
    });

    it('sets userId to null for API key auth', async () => {
      const mw = makeMiddleware({ withApiKey: true });
      const { res } = await call(mw, makeReq({ apiKey: TEST_API_KEY }));
      assert.equal(res.locals['userId'], null);
    });

    it('grants raw execution-data access for API key auth', async () => {
      const mw = makeMiddleware({ withApiKey: true });
      const { res } = await call(mw, makeReq({ apiKey: TEST_API_KEY }));
      assert.equal(res.locals['canViewRawExecutionData'], true);
    });

    it('falls through to JWT path when internalApiKey not configured', async () => {
      const mw = makeMiddleware({ withApiKey: false });
      const { res } = await call(mw, makeReq({ apiKey: TEST_API_KEY }));
      assert.equal(res._status, 401);
    });

    it('rejects when x-api-key does not match', async () => {
      const mw = makeMiddleware({ withApiKey: true });
      const { res, nextCalled } = await call(mw, makeReq({ apiKey: 'wrong-key' }));
      assert.equal(nextCalled, false);
    });
  });

  describe('internal API key (Bearer token)', () => {
    it('passes when Bearer token matches internalApiKey', async () => {
      const mw = makeMiddleware({ withApiKey: true });
      const { res, nextCalled } = await call(mw, makeReq({ authorization: `Bearer ${TEST_API_KEY}` }));
      assert.equal(nextCalled, true);
      assert.equal(res.locals['isSuperAdmin'], true);
      assert.equal(res.locals['canViewRawExecutionData'], true);
    });

    it('grants company admins raw execution-data access without granting super-admin scope', async () => {
      const mw = makeMiddleware({
        sessionResult: {
          companyId: 'co-1', role: 'COMPANY_ADMIN', userId: 'u-1',
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: null,
        },
      });
      const token = buildJwt({ userId: 'u-1', sessionId: 'sess-1', role: 'COMPANY_ADMIN' }, TEST_SECRET, 3600);
      const { res, nextCalled } = await call(mw, makeReq({ authorization: `Bearer ${token}` }));
      assert.equal(nextCalled, true);
      assert.equal(res.locals['isSuperAdmin'], false);
      assert.equal(res.locals['canViewRawExecutionData'], true);
    });
  });

  describe('JWT validation', () => {
    it('returns 401 for malformed token (not 3 parts)', async () => {
      const mw = makeMiddleware({});
      const { res } = await call(mw, makeReq({ authorization: 'Bearer notavalidjwt' }));
      assert.equal(res._status, 401);
    });

    it('returns 401 for token signed with wrong secret', async () => {
      const token = buildJwt({ userId: 'u1', sessionId: 's1', role: 'ADMIN' }, 'wrong-secret', 3600);
      const mw = makeMiddleware({});
      const { res } = await call(mw, makeReq({ authorization: `Bearer ${token}` }));
      assert.equal(res._status, 401);
    });

    it('returns 401 for expired token', async () => {
      const token = buildJwt({ userId: 'u1', sessionId: 's1', role: 'ADMIN' }, TEST_SECRET, -60);
      const mw = makeMiddleware({});
      const { res } = await call(mw, makeReq({ authorization: `Bearer ${token}` }));
      assert.equal(res._status, 401);
    });

    it('returns 401 when token lacks sessionId', async () => {
      const token = buildJwt({ userId: 'u1', role: 'ADMIN' }, TEST_SECRET, 3600);
      const mw = makeMiddleware({ sessionResult: null });
      const { res } = await call(mw, makeReq({ authorization: `Bearer ${token}` }));
      assert.equal(res._status, 401);
    });
  });

  describe('AdminSession DB lookup', () => {
    const validToken = buildJwt({ userId: 'u1', sessionId: 'sess-1', role: 'ADMIN' }, TEST_SECRET, 3600);

    it('returns 401 when session not found', async () => {
      const mw = makeMiddleware({ sessionResult: null });
      const { res } = await call(mw, makeReq({ authorization: `Bearer ${validToken}` }));
      assert.equal(res._status, 401);
    });

    it('returns 401 when session is revoked', async () => {
      const mw = makeMiddleware({
        sessionResult: {
          companyId: 'co-1', role: 'ADMIN', userId: 'u1',
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: new Date(),
        },
      });
      const { res } = await call(mw, makeReq({ authorization: `Bearer ${validToken}` }));
      assert.equal(res._status, 401);
    });

    it('returns 401 when session is DB-expired', async () => {
      const mw = makeMiddleware({
        sessionResult: {
          companyId: 'co-1', role: 'ADMIN', userId: 'u1',
          expiresAt: new Date(Date.now() - 1000),
          revokedAt: null,
        },
      });
      const { res } = await call(mw, makeReq({ authorization: `Bearer ${validToken}` }));
      assert.equal(res._status, 401);
    });

    it('returns 500 when DB throws', async () => {
      const mw = makeMiddleware({ sessionThrows: true });
      const { res } = await call(mw, makeReq({ authorization: `Bearer ${validToken}` }));
      assert.equal(res._status, 500);
    });

    it('calls next() and populates res.locals on valid session', async () => {
      const mw = makeMiddleware({
        sessionResult: {
          companyId: 'co-1', role: 'ADMIN', userId: 'u1',
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: null,
        },
      });
      const { res, nextCalled } = await call(mw, makeReq({ authorization: `Bearer ${validToken}` }));
      assert.equal(nextCalled, true);
      assert.equal(res.locals['companyId'], 'co-1');
      assert.equal(res.locals['userId'], 'u1');
      assert.equal(res.locals['isSuperAdmin'], false);
    });

    it('sets isSuperAdmin=true when role is SUPER_ADMIN', async () => {
      const mw = makeMiddleware({
        sessionResult: {
          companyId: 'co-1', role: 'SUPER_ADMIN', userId: 'u1',
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: null,
        },
      });
      const { res, nextCalled } = await call(mw, makeReq({ authorization: `Bearer ${validToken}` }));
      assert.equal(nextCalled, true);
      assert.equal(res.locals['isSuperAdmin'], true);
    });

    it('token without exp field is accepted (no expiry enforcement)', async () => {
      const noExpToken = buildJwt({ userId: 'u1', sessionId: 'sess-1', role: 'ADMIN' }, TEST_SECRET);
      const mw = makeMiddleware({
        sessionResult: {
          companyId: 'co-1', role: 'ADMIN', userId: 'u1',
          expiresAt: new Date(Date.now() + 3_600_000),
          revokedAt: null,
        },
      });
      const { nextCalled } = await call(mw, makeReq({ authorization: `Bearer ${noExpToken}` }));
      assert.equal(nextCalled, true);
    });
  });
});
