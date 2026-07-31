/** Unit tests for the safe Web Search admin observability route. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createWebSearchAdminRoutes } from '../../src/http/admin/web-search.routes.ts';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000002';
const COMPANY_ADMIN_LOCALS = { companyId: COMPANY_ID, isSuperAdmin: false, userId: 'u-1' };

async function callRoute(
  router: ReturnType<typeof createWebSearchAdminRoutes>,
  opts: { query?: Record<string, string>; locals?: Record<string, unknown> } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};
    const req = { method: 'GET', path: '/connections', query: opts.query ?? {}, headers: {} } as unknown as Request;
    const res = {
      locals: opts.locals ?? { isSuperAdmin: true, userId: 'u-sa' },
      status: (nextStatus: number) => { status = nextStatus; return res; },
      json: (body: unknown) => { responseBody = body; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;
    const next = (error?: unknown) => {
      status = error instanceof Error && 'status' in error ? Number((error as { status?: number }).status) || 500 : 404;
      responseBody = { success: false, message: error instanceof Error ? error.message : 'not_found' };
      resolve({ status, body: responseBody });
    };
    const layer = ((router as any).stack ?? []).find((item: any) => item.route?.path === '/connections');
    const handler = layer?.route?.stack?.[0]?.handle;
    if (!handler) { next(); return; }
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1', companyId: COMPANY_ID, label: 'Primary', status: 'connected', priority: 0,
    lastTestedAt: null, lastSucceededAt: null, lastFailureAt: null, lastFailureCode: null,
    lastUsedAt: new Date('2026-07-19T17:00:00.000Z'), successfulRequestCount: 12,
    creditsAtLastSync: 100, usageAtLastCreditSync: 8,
    creditsSyncedAt: new Date('2026-07-19T16:00:00.000Z'), unavailableUntil: null,
    createdAt: new Date('2026-07-01T12:00:00.000Z'), updatedAt: new Date('2026-07-19T17:00:00.000Z'),
    apiKeyEncrypted: 'must-never-be-returned',
    company: { id: COMPANY_ID, name: 'Acme' },
    createdByUser: { id: 'u-1', name: 'Ada Admin', email: 'ada@example.com' },
    ...overrides,
  };
}

describe('GET /connections (web-search)', () => {
  it('returns only safe metadata and computes Divo-observed estimates', async () => {
    let capturedArgs: any;
    const router = createWebSearchAdminRoutes({
      prisma: { companySerperConnection: { findMany: async (args: unknown) => { capturedArgs = args; return [connection()]; } } } as any,
    });

    const { status, body } = await callRoute(router, { locals: COMPANY_ADMIN_LOCALS });
    assert.equal(status, 200);
    const data = (body as any).data;
    assert.deepEqual(capturedArgs.where, { revokedAt: null, companyId: COMPANY_ID });
    assert.equal(capturedArgs.select.apiKeyEncrypted, undefined);
    assert.equal(data.connections[0].addedBy.email, 'ada@example.com');
    assert.equal(data.connections[0].observedRequestsSinceCreditSync, 4);
    assert.equal(data.connections[0].estimatedCreditsRemaining, 96);
    assert.equal(JSON.stringify(data).includes('must-never-be-returned'), false);
  });

  it('prevents company admins from viewing another company', async () => {
    const router = createWebSearchAdminRoutes({
      prisma: { companySerperConnection: { findMany: async () => [] } } as any,
    });
    const { status } = await callRoute(router, {
      locals: COMPANY_ADMIN_LOCALS,
      query: { companyId: OTHER_COMPANY_ID },
    });
    assert.equal(status, 403);
  });

  it('lets super admins view all company connections', async () => {
    let capturedArgs: any;
    const router = createWebSearchAdminRoutes({
      prisma: { companySerperConnection: { findMany: async (args: unknown) => { capturedArgs = args; return [connection()]; } } } as any,
    });
    const { status, body } = await callRoute(router, { locals: { isSuperAdmin: true, userId: 'u-sa' } });
    assert.equal(status, 200);
    assert.deepEqual(capturedArgs.where, { revokedAt: null });
    assert.equal((body as any).data.summary.companyCount, 1);
  });
});
