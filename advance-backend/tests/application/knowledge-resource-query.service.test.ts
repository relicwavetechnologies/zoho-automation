import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../../src/shared/result.ts';
import { KnowledgeResourceQueryService } from '../../src/application/knowledge/knowledge-resource-query.service.ts';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    companyId: 'company',
    kind: 'skill',
    scope: 'personal',
    targetKey: 'personal:user',
    ownerUserId: 'user',
    departmentId: null,
    logicalKey: 'reports.weekly.procedure',
    status: 'active',
    currentVersion: 2,
    createdById: 'user',
    createdAt: new Date('2026-07-31T00:00:00.000Z'),
    updatedAt: new Date('2026-07-31T01:00:00.000Z'),
    department: null,
    versions: [{
      version: 2,
      contentJson: {
        name: 'Weekly Report Procedure',
        slug: 'weekly-report-procedure',
        summary: 'Create the approved weekly report.',
        markdown: '# Weekly Report\n\nUse two columns.',
        toolIds: [],
        tags: ['reports'],
      },
    }],
    ...overrides,
  };
}

describe('KnowledgeResourceQueryService', () => {
  it('derives personal, company, and live-department visibility from identity', async () => {
    let captured: any;
    const service = new KnowledgeResourceQueryService({
      prisma: {
        knowledgeResource: {
          findMany: async (args: unknown) => {
            captured = args;
            return [row()];
          },
        },
      } as any,
      departments: {
        listActiveMemberships: async () => ok([
          { departmentId: 'department-a', departmentName: 'Tech Testing' },
          { departmentId: 'department-b', departmentName: 'Finance' },
        ] as any),
      },
    });

    const resources = await service.list({
      companyId: 'company',
      userId: 'user',
      kind: 'skill',
      query: 'weekly report',
      limit: 10,
    });

    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.currentVersion, 2);
    assert.equal('content' in resources[0]!, false);
    assert.deepEqual(captured.where.OR, [
      { scope: 'personal', ownerUserId: 'user' },
      { scope: 'company' },
      { scope: 'department', departmentId: { in: ['department-a', 'department-b'] } },
    ]);
    assert.equal(captured.where.companyId, 'company');
    assert.equal(captured.where.kind, 'skill');
    assert.equal(captured.where.status, 'active');
  });

  it('returns the exact current canonical content needed for an update', async () => {
    const service = new KnowledgeResourceQueryService({
      prisma: {
        knowledgeResource: { findMany: async () => [row()] },
      } as any,
      departments: { listActiveMemberships: async () => ok([] as any) },
    });

    const resource = await service.get({
      companyId: 'company',
      userId: 'user',
      resourceId: '11111111-1111-4111-8111-111111111111',
    });

    assert.equal(resource?.logicalKey, 'reports.weekly.procedure');
    assert.equal(resource?.currentVersion, 2);
    assert.deepEqual(resource?.content, row().versions[0]?.contentJson);
  });

  it('resolves an exact personal-memory key without accepting a scope owner', async () => {
    let captured: any;
    const memory = row({
      kind: 'memory',
      logicalKey: 'communication.answers.detail',
      versions: [{
        version: 2,
        contentJson: { facts: ['The user prefers detailed answers.'] },
      }],
    });
    const service = new KnowledgeResourceQueryService({
      prisma: {
        knowledgeResource: {
          findMany: async (args: unknown) => {
            captured = args;
            return [memory];
          },
        },
      } as any,
      departments: { listActiveMemberships: async () => ok([] as any) },
    });

    const resource = await service.getPersonalMemoryByLogicalKey({
      companyId: 'company',
      userId: 'user',
      logicalKey: 'communication.answers.detail',
    });

    assert.equal(resource?.kind, 'memory');
    assert.equal(resource?.scope, 'personal');
    assert.equal(captured.where.kind, 'memory');
    assert.equal(captured.where.scope, 'personal');
    assert.equal(captured.where.logicalKey, 'communication.answers.detail');
    assert.deepEqual(captured.where.OR[0], { scope: 'personal', ownerUserId: 'user' });
  });

  it('fails closed when the projected row has no matching canonical current version', async () => {
    const service = new KnowledgeResourceQueryService({
      prisma: {
        knowledgeResource: {
          findMany: async () => [row({ currentVersion: 3 })],
        },
      } as any,
      departments: { listActiveMemberships: async () => ok([] as any) },
    });

    const resource = await service.get({
      companyId: 'company',
      userId: 'user',
      resourceId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(resource, null);
  });

  it('hydrates indexed memory hits through the same live visibility boundary', async () => {
    let rawQuery: any;
    let membershipReads = 0;
    const memory = row({
      kind: 'memory',
      logicalKey: 'reports.weekly.format',
      versions: [{
        version: 2,
        contentJson: { facts: ['Weekly reports use a two-column table.'] },
      }],
    });
    const service = new KnowledgeResourceQueryService({
      prisma: {
        $queryRaw: async (query: unknown) => {
          rawQuery = query;
          return [{ resourceId: memory.id, score: 0.75, coverage: 0.8 }];
        },
        knowledgeResource: { findMany: async () => [memory] },
      } as any,
      departments: {
        listActiveMemberships: async () => {
          membershipReads += 1;
          return ok([{ departmentId: 'dept-1', departmentName: 'Tech Testing' }] as any);
        },
      },
    });

    const matches = await service.searchMemories({
      companyId: 'company',
      userId: 'user',
      query: 'weekly report format',
      scope: 'personal',
      limit: 3,
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.resource.scope, 'personal');
    assert.equal(matches[0]?.score, 0.75);
    assert.equal(matches[0]?.coverage, 0.8);
    assert.equal(membershipReads, 2, 'search and canonical hydration both re-check membership');
    assert.ok(rawQuery.values.includes('company'));
    assert.ok(rawQuery.values.includes('user'));
    assert.ok(rawQuery.values.includes('weekly report format'));
  });
});
