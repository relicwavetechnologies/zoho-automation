import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { createShopifyPrivacyRoutes } from '../../src/http/admin/shopify-privacy.routes';
import { ok } from '../../src/shared/result';

const readyRequest = {
  id: 'privacy-1',
  companyId: 'company-1',
  shopDomain: 'demo.myshopify.com',
  requestId: 'request-1',
  customerIdHash: 'a'.repeat(64),
  orderIdHashes: [],
  state: 'ready' as const,
  failureCode: null,
  deadlineAt: new Date('2026-09-01T00:00:00.000Z'),
  expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  readyAt: new Date('2026-08-03T00:00:00.000Z'),
  deliveredAt: null,
  redactedAt: null,
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
  updatedAt: new Date('2026-08-03T00:00:00.000Z'),
  exportPayload: { retainedCustomerOrOrderRecords: [] },
};

describe('Shopify privacy admin routes', () => {
  it('rejects department managers before protected storage is called', async () => {
    let calls = 0;
    const repository = makeRepository({ onCall: () => { calls += 1; } });
    const response = await callRoute(repository, {
      method: 'GET', path: '/:id', role: 'DEPARTMENT_MANAGER', params: { id: 'privacy-1' },
      query: { shopDomain: 'demo.myshopify.com' },
    });
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  });

  it('tenant-scopes exact export access and attributes the actor', async () => {
    let getInput: unknown;
    const repository = makeRepository({ get: async input => { getInput = input; return ok(readyRequest); } });
    const response = await callRoute(repository, {
      method: 'GET', path: '/:id', role: 'COMPANY_ADMIN', params: { id: 'privacy-1' },
      query: { shopDomain: 'demo.myshopify.com' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(getInput, {
      companyId: 'company-1',
      shopDomain: 'demo.myshopify.com',
      id: 'privacy-1',
      actorId: 'admin-1',
    });
  });

  it('acknowledges externally delivered exports without returning protected data', async () => {
    const calls: unknown[] = [];
    const repository = makeRepository({
      markDelivered: async input => { calls.push(['deliver', input]); return ok(true); },
    });
    const response = await callRoute(repository, {
      method: 'POST', path: '/:id/delivery-acknowledgement', role: 'COMPANY_ADMIN', params: { id: 'privacy-1' },
      body: {
        shopDomain: 'demo.myshopify.com',
        channel: 'email',
        recipient: 'subject@example.com',
        receiptId: 'provider-message-1',
        deliveredAt: '2026-08-03T12:00:00.000Z',
      },
    });
    assert.equal(response.status, 200);
    assert.equal((response.body as any).data.state, 'delivered');
    assert.equal('exportPayload' in (response.body as any).data, false);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0] as any)[1].deliveryEvidence, {
      channel: 'email',
      recipient: 'subject@example.com',
      receiptId: 'provider-message-1',
      deliveredAt: new Date('2026-08-03T12:00:00.000Z'),
    });
    assert.equal((calls[0] as any)[1].actorId, 'admin-1');
  });

  it('rejects delivery acknowledgement without external receipt evidence', async () => {
    let calls = 0;
    const response = await callRoute(makeRepository({ onCall: () => { calls += 1; } }), {
      method: 'POST', path: '/:id/delivery-acknowledgement', role: 'COMPANY_ADMIN', params: { id: 'privacy-1' },
      body: { shopDomain: 'demo.myshopify.com' },
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  });

  it('requires an explicit company for super-admin access', async () => {
    const response = await callRoute(makeRepository({}), {
      method: 'GET', path: '/', role: 'SUPER_ADMIN', query: {},
    });
    assert.equal(response.status, 400);
  });
});

function makeRepository(overrides: Record<string, any>) {
  const onCall = overrides['onCall'] ?? (() => {});
  return {
    create: async () => { onCall(); return ok({ created: true, request: readyRequest }); },
    list: overrides['list'] ?? (async () => { onCall(); return ok([]); }),
    get: overrides['get'] ?? (async () => { onCall(); return ok(null); }),
    markDelivered: overrides['markDelivered'] ?? (async () => { onCall(); return ok(false); }),
    redact: async () => { onCall(); return ok({ affected: 0, hasMore: false }); },
    sweep: async () => { onCall(); return ok({ affected: 0, hasMore: false }); },
  };
}

async function callRoute(
  repository: any,
  input: {
    method: 'GET' | 'POST';
    path: string;
    role: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown }> {
  const router = createShopifyPrivacyRoutes({ repository });
  const req = {
    method: input.method,
    query: input.query ?? {},
    body: input.body ?? {},
    params: input.params ?? {},
  } as unknown as Request;
  let status = 200;
  let body: unknown;
  const res = {
    locals: {
      companyId: 'company-1',
      userId: 'admin-1',
      adminRole: input.role,
      isSuperAdmin: input.role === 'SUPER_ADMIN',
    },
    status: (value: number) => { status = value; return res; },
    json: (value: unknown) => { body = value; return res; },
  } as unknown as Response;
  const guard = (router as any).stack.find((layer: any) => !layer.route);
  let allowed = false;
  await guard.handle(req, res, () => { allowed = true; });
  if (allowed) {
    const layer = (router as any).stack.find((candidate: any) =>
      candidate.route?.path === input.path && candidate.route?.methods?.[input.method.toLowerCase()]);
    assert.ok(layer);
    await layer.route.stack[0].handle(req, res);
  }
  return { status, body };
}
