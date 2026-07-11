import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAdminAuthRoutes } from '../../src/http/admin/admin-auth.routes.ts';
import { buildShareMemorySystemSkill } from '../../src/application/skills/share-memory-system-skill.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

async function callPost(
  router: ReturnType<typeof createAdminAuthRoutes>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const req = { method: 'POST', path, body, headers: {} } as unknown as Request;
    const res = {
      locals: {},
      status: (nextStatus: number) => { status = nextStatus; return res; },
      json: (responseBody: unknown) => {
        resolve({ status, body: responseBody });
        return res;
      },
    } as unknown as Response;
    const layer = (router as any).stack.find((candidate: any) =>
      candidate.route?.path === path && candidate.route.methods?.post);
    const handler = layer?.route?.stack?.[0]?.handle;
    if (!handler) {
      reject(new Error(`POST ${path} route not found`));
      return;
    }
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

describe('admin auth company signup provisioning', () => {
  it('creates the canonical Share Memory system skill in the company transaction', async () => {
    const companyId = '11111111-2222-4333-8444-555555555555';
    const expectedSkill = buildShareMemorySystemSkill(companyId);
    let capturedUpsert: any = null;
    const tx = {
      user: {
        create: async ({ data }: any) => ({ id: 'user-1', ...data }),
      },
      company: {
        create: async () => ({ id: companyId }),
      },
      skill: {
        findFirst: async () => null,
        upsert: async (args: any) => {
          capturedUpsert = args;
          return { id: args.create.id };
        },
      },
      adminMembership: {
        create: async ({ data }: any) => ({ id: 'membership-1', ...data }),
      },
      adminSession: {
        create: async ({ data }: any) => ({
          ...data,
          sessionId: 'session-1',
          companyId: data.companyId ?? null,
          expiresAt: data.expiresAt,
          revokedAt: null,
        }),
      },
    };
    const prisma = {
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    } as any;
    const auditRecords: unknown[] = [];
    const router = createAdminAuthRoutes({
      prisma,
      env: { ADMIN_JWT_SECRET: 'test-admin-jwt-secret' } as any,
      auditService: { record: (record: unknown) => { auditRecords.push(record); } } as any,
      logger: noopLogger,
    });

    const result = await callPost(router, '/signup/company-admin', {
      email: 'owner@example.com',
      password: 'password-123',
      name: 'Owner',
      companyName: 'New Company',
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data.session.companyId, companyId);
    assert.equal(expectedSkill.id, '4ac99e6d-cc63-518c-cd8d-a480b35c93d9');
    assert.deepEqual(capturedUpsert.where, { id: expectedSkill.id });
    assert.deepEqual(capturedUpsert.create, expectedSkill);
    assert.equal(capturedUpsert.create.slug, 'share-memory');
    assert.equal(capturedUpsert.create.isSystem, true);
    assert.deepEqual(capturedUpsert.create.toolIds, ['memoryPublishing']);
    assert.match(capturedUpsert.create.markdown, /divo_memory_review/);
    assert.match(capturedUpsert.create.markdown, /only `proposalId` and the proposed `bullets`/);
    assert.match(capturedUpsert.create.markdown, /Never pass `departmentId` or `allowedTargets`/);
    assert.match(capturedUpsert.create.markdown, /desktop-configured department context/);
    assert.equal(auditRecords.length, 1);
  });
});
