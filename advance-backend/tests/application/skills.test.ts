/**
 * Unit tests for SkillRepository and SkillsService.
 *
 * SkillRepository: wraps Prisma, returns Result<T, InfraError>
 *   - search(): filters by companyId + status + dept scope + text query
 *   - findById(): lookup by id or slug, returns null when not found
 *   - both wrap DB errors in InfraError (never throws)
 *
 * SkillsService: adapts SkillRepoPort → SkillPort
 *   - maps SkillRow to SkillRecord (only surfaces public fields)
 *   - swallows repo errors and returns safe empty / null
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SkillRepository, searchTerms } from '../../src/infrastructure/persistence/skill.repository.ts';
import { SkillsService }   from '../../src/application/context-search/skills.service.ts';
import type { SkillRepoPort, SkillRow } from '../../src/infrastructure/persistence/skill.repository.ts';
import { ok, err } from '../../src/shared/result.ts';
import type { InfraError } from '../../src/shared/errors.ts';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

function fakeRow(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id:           'skill-1',
    slug:         'pto-policy',
    name:         'PTO Policy',
    summary:      'How PTO works',
    markdown:     '# PTO Policy\n\nYou get 20 days.',
    toolIds:      ['contextSearch'],
    scope:        'company',
    status:       'active',
    tags:         ['hr', 'pto'],
    companyId:    'co-1',
    departmentId: null,
    ...overrides,
  };
}

describe('SkillRepository', () => {
  describe('list()', () => {
    it('returns visible rows ordered by sort order', async () => {
      let captured: any = null;
      const prisma = {
        skill: { findMany: async (args: any) => { captured = args; return [fakeRow()]; } },
      } as any;
      const repo = new SkillRepository(prisma);
      const result = await repo.list({ companyId: 'co-1', departmentId: 'dept-1', limit: 10 });
      assert.equal(result.ok, true);
      assert.equal((result as any).value.length, 1);
      assert.equal(captured.where.companyId, 'co-1');
      assert.deepEqual(captured.where.AND, [
        { OR: [{ scope: { in: ['company', 'global'] }, departmentId: null }, { scope: 'department', departmentId: 'dept-1' }] },
      ]);
    });
  });

  describe('search()', () => {
    it('tokenizes a natural-language task instead of requiring the full sentence as one substring', () => {
      assert.deepEqual(
        searchTerms('Create a Google Sheet with columns, freeze the header, and return the URL'),
        ['create', 'google', 'sheet', 'columns', 'freeze', 'header', 'url'],
      );
    });

    it('returns ok with rows from Prisma', async () => {
      const prisma = {
        skill: { findMany: async () => [fakeRow()] },
      } as any;
      const repo = new SkillRepository(prisma);
      const result = await repo.search({ companyId: 'co-1', query: 'pto', limit: 10 });
      assert.equal(result.ok, true);
      assert.equal((result as any).value.length, 1);
      assert.equal((result as any).value[0].slug, 'pto-policy');
    });

    it('returns ok with empty array when no matches', async () => {
      const prisma = {
        skill: { findMany: async () => [] },
      } as any;
      const repo = new SkillRepository(prisma);
      const result = await repo.search({ companyId: 'co-1', query: 'xyz', limit: 10 });
      assert.equal(result.ok, true);
      assert.equal((result as any).value.length, 0);
    });

    it('passes companyId filter to Prisma', async () => {
      let captured: any = null;
      const prisma = {
        skill: { findMany: async (args: any) => { captured = args; return []; } },
      } as any;
      const repo = new SkillRepository(prisma);
      await repo.search({ companyId: 'co-xyz', query: 'foo', limit: 5 });
      assert.equal(captured.where.companyId, 'co-xyz');
    });

    it('passes take=limit to Prisma', async () => {
      let captured: any = null;
      const prisma = {
        skill: { findMany: async (args: any) => { captured = args; return []; } },
      } as any;
      const repo = new SkillRepository(prisma);
      await repo.search({ companyId: 'co-1', query: 'foo', limit: 7 });
      assert.equal(captured.take, 7);
    });

    it('combines department visibility and text search without overwriting either OR clause', async () => {
      let captured: any = null;
      const prisma = {
        skill: { findMany: async (args: any) => { captured = args; return []; } },
      } as any;
      const repo = new SkillRepository(prisma);
      await repo.search({ companyId: 'co-1', departmentId: 'dept-1', query: 'foo', limit: 5 });
      assert.deepEqual(captured.where.AND[0], {
        OR: [{ scope: { in: ['company', 'global'] }, departmentId: null }, { scope: 'department', departmentId: 'dept-1' }],
      });
      assert.ok(Array.isArray(captured.where.AND[1].OR));
      assert(captured.where.AND[1].OR.some((entry: any) => entry.aliases?.some));
      assert(captured.where.AND[1].OR.some((entry: any) => entry.tags?.has === 'foo'));
    });

    it('scopes to company skills only when no departmentId provided', async () => {
      let captured: any = null;
      const prisma = {
        skill: { findMany: async (args: any) => { captured = args; return []; } },
      } as any;
      const repo = new SkillRepository(prisma);
      await repo.search({ companyId: 'co-1', query: 'foo', limit: 5 });
      assert.deepEqual(captured.where.AND[0], { scope: { in: ['company', 'global'] }, departmentId: null });
    });

    it('wraps Prisma error as InfraError', async () => {
      const prisma = {
        skill: { findMany: async () => { throw new Error('db crash'); } },
      } as any;
      const repo = new SkillRepository(prisma);
      const result = await repo.search({ companyId: 'co-1', query: 'foo', limit: 5 });
      assert.equal(result.ok, false);
      assert.equal((result as any).error.kind, 'infra');
    });
  });

  describe('findById()', () => {
    it('returns ok with row when found', async () => {
      const prisma = {
        skill: { findFirst: async () => fakeRow() },
      } as any;
      const repo = new SkillRepository(prisma);
      const result = await repo.findById({ companyId: 'co-1', skillId: 'skill-1' });
      assert.equal(result.ok, true);
      assert.equal((result as any).value!.id, 'skill-1');
    });

    it('returns ok with null when not found', async () => {
      const prisma = {
        skill: { findFirst: async () => null },
      } as any;
      const repo = new SkillRepository(prisma);
      const result = await repo.findById({ companyId: 'co-1', skillId: 'missing' });
      assert.equal(result.ok, true);
      assert.equal((result as any).value, null);
    });

    it('wraps Prisma error as InfraError', async () => {
      const prisma = {
        skill: { findFirst: async () => { throw new Error('db crash'); } },
      } as any;
      const repo = new SkillRepository(prisma);
      const result = await repo.findById({ companyId: 'co-1', skillId: 'x' });
      assert.equal(result.ok, false);
      assert.equal((result as any).error.kind, 'infra');
    });

    it('combines department visibility and id lookup without overwriting either OR clause', async () => {
      let captured: any = null;
      const prisma = {
        skill: { findFirst: async (args: any) => { captured = args; return null; } },
      } as any;
      const repo = new SkillRepository(prisma);
      await repo.findById({ companyId: 'co-1', departmentId: 'dept-2', skillId: 'x' });
      assert.deepEqual(captured.where.AND[0], {
        OR: [{ scope: { in: ['company', 'global'] }, departmentId: null }, { scope: 'department', departmentId: 'dept-2' }],
      });
      assert.ok(Array.isArray(captured.where.AND[1].OR));
    });
  });

  describe('listRouteTargets()', () => {
    it('keeps router and specialist in the same company and applies department visibility', async () => {
      let captured: any = null;
      const prisma = {
        skillRoute: {
          findMany: async (args: any) => {
            captured = args;
            return [{ targetSkill: fakeRow({ id: 'specialist-1' }) }];
          },
        },
      } as any;
      const repo = new SkillRepository(prisma);

      const result = await repo.listRouteTargets({
        companyId: 'co-1',
        departmentId: 'dept-1',
        routerSkillId: 'router-1',
      });

      assert.equal(result.ok, true);
      assert.equal((result as any).value[0].id, 'specialist-1');
      assert.deepEqual(captured.where.routerSkill, {
        companyId: 'co-1',
        status: 'active',
      });
      assert.equal(captured.where.targetSkill.companyId, 'co-1');
      assert.deepEqual(captured.where.targetSkill.AND[0], {
        OR: [
          { scope: { in: ['company', 'global'] }, departmentId: null },
          { scope: 'department', departmentId: 'dept-1' },
        ],
      });
    });
  });
});

// ─── SkillsService ────────────────────────────────────────────────────────────

describe('SkillsService', () => {
  const row = fakeRow();

  describe('search()', () => {
    it('maps SkillRow[] to SkillRecord[]', async () => {
      const repo: SkillRepoPort = {
        list:     async () => ok([]),
        search:   async () => ok([row]),
        findById: async () => ok(null),
        listRouteTargets: async () => ok([]),
        registryRevision: async () => ok(1),
      };
      const svc = new SkillsService({ repo, logger: noopLogger });
      const results = await svc.search({ companyId: 'co-1', query: 'pto', limit: 5 });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.id, 'skill-1');
      assert.equal(results[0]!.slug, 'pto-policy');
      assert.equal(results[0]!.name, 'PTO Policy');
      assert.equal(results[0]!.summary, 'How PTO works');
    });

    it('excludes internal fields (status, tags, scope, companyId)', async () => {
      const repo: SkillRepoPort = {
        list:     async () => ok([]),
        search:   async () => ok([row]),
        findById: async () => ok(null),
        listRouteTargets: async () => ok([]),
        registryRevision: async () => ok(1),
      };
      const svc = new SkillsService({ repo, logger: noopLogger });
      const results = await svc.search({ companyId: 'co-1', query: 'pto', limit: 5 });
      const r = results[0] as any;
      assert.equal('status' in r, false);
      assert.equal('tags' in r, false);
      assert.equal('companyId' in r, false);
    });

    it('returns empty array when repo returns empty', async () => {
      const repo: SkillRepoPort = {
        list:     async () => ok([]),
        search:   async () => ok([]),
        findById: async () => ok(null),
        listRouteTargets: async () => ok([]),
        registryRevision: async () => ok(1),
      };
      const svc = new SkillsService({ repo, logger: noopLogger });
      const results = await svc.search({ companyId: 'co-1', query: 'nothing', limit: 5 });
      assert.equal(results.length, 0);
    });

    it('returns empty array when repo returns InfraError', async () => {
      const infraErr: InfraError = { kind: 'infra', layer: 'prisma', op: 'skill.search', message: 'db down', cause: null };
      const repo: SkillRepoPort = {
        list:     async () => ok([]),
        search:   async () => err(infraErr),
        findById: async () => ok(null),
        listRouteTargets: async () => ok([]),
        registryRevision: async () => ok(1),
      };
      const svc = new SkillsService({ repo, logger: noopLogger });
      const results = await svc.search({ companyId: 'co-1', query: 'pto', limit: 5 });
      assert.equal(results.length, 0);
    });
  });

  describe('readById()', () => {
    it('maps SkillRow to SkillRecord', async () => {
      const repo: SkillRepoPort = {
        list:     async () => ok([]),
        search:   async () => ok([]),
        findById: async () => ok(row),
        listRouteTargets: async () => ok([]),
        registryRevision: async () => ok(1),
      };
      const svc = new SkillsService({ repo, logger: noopLogger });
      const result = await svc.readById({ companyId: 'co-1', skillId: 'skill-1' });
      assert.ok(result !== null);
      assert.equal(result!.id, 'skill-1');
      assert.equal(result!.markdown, '# PTO Policy\n\nYou get 20 days.');
    });

    it('returns null when repo returns null', async () => {
      const repo: SkillRepoPort = {
        list:     async () => ok([]),
        search:   async () => ok([]),
        findById: async () => ok(null),
        listRouteTargets: async () => ok([]),
        registryRevision: async () => ok(1),
      };
      const svc = new SkillsService({ repo, logger: noopLogger });
      const result = await svc.readById({ companyId: 'co-1', skillId: 'missing' });
      assert.equal(result, null);
    });

    it('returns null when repo returns InfraError', async () => {
      const infraErr: InfraError = { kind: 'infra', layer: 'prisma', op: 'skill.findById', message: 'db down', cause: null };
      const repo: SkillRepoPort = {
        list:     async () => ok([]),
        search:   async () => ok([]),
        findById: async () => err(infraErr),
        listRouteTargets: async () => ok([]),
        registryRevision: async () => ok(1),
      };
      const svc = new SkillsService({ repo, logger: noopLogger });
      const result = await svc.readById({ companyId: 'co-1', skillId: 'x' });
      assert.equal(result, null);
    });
  });
});
