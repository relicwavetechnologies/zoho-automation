import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillPublishingTool } from '../../src/application/orchestration/tools/families/skill-publishing.tool.ts';
import { asCompanyRoleSlug } from '../../src/domain/permissions/company-role.ts';
import { asDepartmentId } from '../../src/shared/ids.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

function makePrisma(existing: { id: string } | null = null) {
  let created: unknown = null;
  const prisma = {
    skill: {
      findFirst: async () => existing,
      create: async (args: { data: Record<string, unknown> }) => {
        created = args.data;
        return {
          id: 'skill-1',
          slug: args.data.slug,
          name: args.data.name,
          scope: args.data.scope,
          departmentId: args.data.departmentId,
          toolIds: args.data.toolIds,
          status: 'active',
        };
      },
    },
  };
  return { prisma: prisma as never, getCreated: () => created };
}

describe('skillPublishing tool', () => {
  it('publishes company-scope skills for company admins with create permission', async () => {
    const { prisma, getCreated } = makePrisma();
    const tool = createSkillPublishingTool({ prisma });
    const args = {
      operation: 'publish' as const,
      scope: 'company' as const,
      name: 'Sales Research',
      markdown: '# Sales Research',
      toolIds: ['webSearch'],
    };
    const ctx = makeCtx('skillPublishing', ['create'], {
      companyRole: asCompanyRoleSlug('COMPANY_ADMIN'),
    });

    const perm = tool.permissionCheck(args, ctx.perm);
    assert.equal(perm.ok, true);

    const result = await tool.execute(args, ctx);
    assert.equal(result.ok, true);
    assert.equal((result as any).value.skill.scope, 'global');
    assert.deepEqual(getCreated(), {
      companyId: 'co-test',
      departmentId: null,
      scope: 'global',
      name: 'Sales Research',
      slug: 'sales-research',
      summary: '',
      markdown: '# Sales Research',
      toolIds: ['webSearch'],
      tags: [],
      status: 'active',
      createdBy: 'user-test',
      updatedBy: 'user-test',
    });
  });

  it('allows department managers to publish department-scope skills', async () => {
    const { prisma } = makePrisma();
    const tool = createSkillPublishingTool({ prisma });
    const args = {
      operation: 'publish' as const,
      scope: 'department' as const,
      name: 'Finance Follow Up',
      markdown: '# Finance Follow Up',
      toolIds: ['larkTask'],
    };
    const ctx = makeCtx(undefined, undefined, {
      departmentId: asDepartmentId('dept-1'),
    });
    const perm = {
      ...makeDeniedPerm(),
      department: {
        id: asDepartmentId('dept-1'),
        name: 'Finance',
        roleSlug: 'MANAGER' as never,
        zohoReadScope: 'personalized' as const,
      },
    };

    const check = tool.permissionCheck(args, perm);
    assert.equal(check.ok, true);

    const result = await tool.execute({ ...args, departmentId: 'dept-1' }, { ...ctx, perm });
    assert.equal(result.ok, true);
    assert.equal((result as any).value.skill.departmentId, 'dept-1');
  });

  it('denies members publishing company-scope skills', async () => {
    const { prisma } = makePrisma();
    const tool = createSkillPublishingTool({ prisma });
    const args = {
      operation: 'publish' as const,
      scope: 'company' as const,
      name: 'Private Skill',
      markdown: '# Private Skill',
      toolIds: ['webSearch'],
    };

    const denied = tool.permissionCheck(args, makeDeniedPerm());
    assert.equal(denied.ok, false);

    const result = await tool.execute(args, makeCtx('skillPublishing', ['create']));
    assert.equal(result.ok, false);
  });

  it('reports duplicate slugs as bad args', async () => {
    const { prisma } = makePrisma({ id: 'existing' });
    const tool = createSkillPublishingTool({ prisma });
    const result = await tool.execute({
      operation: 'publish',
      scope: 'company',
      name: 'Existing',
      markdown: '# Existing',
      toolIds: ['webSearch'],
    }, makeCtx('skillPublishing', ['create'], { companyRole: asCompanyRoleSlug('COMPANY_ADMIN') }));

    assert.equal(result.ok, false);
    assert.match((result as any).error.message, /already exists/);
  });
});
