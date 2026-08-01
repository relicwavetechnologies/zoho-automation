import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAdminAuthRoutes } from '../../src/http/admin/admin-auth.routes.ts';
import { buildKnowledgeManagementSystemSkill } from '../../src/application/skills/knowledge-system-skill.ts';

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
  it('creates the canonical Manage Knowledge system skill in the company transaction', async () => {
    const companyId = '11111111-2222-4333-8444-555555555555';
    const expectedSkill = buildKnowledgeManagementSystemSkill(companyId);
    let capturedUpsert: any = null;
    const createdSkillSlugs: string[] = [];
    const createdSkills = new Map<string, { id: string; slug: string }>();
    const createdRoutes: Array<{ routerSkillId: string; targetSkillId: string }> = [];
    const tx = {
      user: {
        create: async ({ data }: any) => ({ id: 'user-1', ...data }),
      },
      company: {
        create: async () => ({ id: companyId }),
      },
      skill: {
        findFirst: async () => null,
        findMany: async ({ where }: any) =>
          [...createdSkills.values()].filter(skill => where.slug.in.includes(skill.slug)),
        create: async ({ data }: any) => {
          createdSkillSlugs.push(data.slug);
          createdSkills.set(data.id, { id: data.id, slug: data.slug });
          return {
            ...data,
            revision: data.revision ?? 1,
            createdBy: data.createdBy ?? null,
            updatedBy: data.updatedBy ?? null,
          };
        },
        update: async ({ data }: any) => ({ ...data }),
        upsert: async (args: any) => {
          capturedUpsert = args;
          createdSkills.set(args.create.id, {
            id: args.create.id,
            slug: args.create.slug,
          });
          return { ...args.create, revision: 1, createdBy: null, updatedBy: null };
        },
      },
      skillRoute: {
        deleteMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => {
          createdRoutes.push(...data.map((route: any) => ({
            routerSkillId: route.routerSkillId,
            targetSkillId: route.targetSkillId,
          })));
          return { count: data.length };
        },
      },
      skillFolder: {
        findFirst: async () => null,
        upsert: async ({ create }: any) => ({ id: create.id }),
      },
      skillAccessGrant: {
        upsert: async () => ({}),
      },
      skillVersion: {
        upsert: async () => ({}),
      },
      skillAlias: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: any) => ({ count: data.length }),
      },
      skillRegistryRevision: {
        upsert: async () => ({}),
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
    assert.deepEqual(capturedUpsert.create.toolIds, ['knowledge']);
    assert.match(capturedUpsert.create.markdown, /divo_memory_review/);
    assert.match(capturedUpsert.create.markdown, /divo_knowledge_review/);
    assert.match(capturedUpsert.create.markdown, /different active manager/);
    assert.match(capturedUpsert.create.markdown, /different active company administrator/);
    assert.match(capturedUpsert.create.markdown, /Never downgrade, redirect, duplicate/);
    for (const slug of [
      'airtable-core',
      'airtable-schema-ops',
      'airtable-automation-ops',
      'aitable-datasheets',
      'aitable-fields',
      'divo-semrush-seo-research',
    ]) {
      assert(createdSkillSlugs.includes(slug), `missing signup system skill: ${slug}`);
    }
    const skillIdBySlug = new Map(
      [...createdSkills.values()].map(skill => [skill.slug, skill.id]),
    );
    assert(createdRoutes.some(route =>
      route.routerSkillId === skillIdBySlug.get('research-router')
      && route.targetSkillId === skillIdBySlug.get('divo-semrush-seo-research')));
    assert.equal(auditRecords.length, 1);
  });
});
