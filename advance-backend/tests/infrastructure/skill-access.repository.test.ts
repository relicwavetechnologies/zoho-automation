import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SkillAccessRepository } from '../../src/infrastructure/persistence/skill-access.repository.ts';
import { createMemberGrantScope } from '../../src/domain/permissions/member-grant-scope.ts';

describe('SkillAccessRepository', () => {
  it('combines company, user, active department, and role grants', async () => {
    let grantWhere: any;
    const prisma = {
      departmentMembership: {
        findMany: async () => [
          { departmentId: 'dep-1', roleId: 'role-1' },
          { departmentId: 'dep-2', roleId: 'role-2' },
        ],
      },
      skillAccessGrant: {
        findMany: async (input: any) => {
          grantWhere = input.where;
          return [{ skillId: 'skill-a' }, { skillId: 'skill-b' }, { skillId: 'skill-a' }];
        },
      },
    };

    const result = await new SkillAccessRepository(prisma as any)
      .listGrantedSkillIds('company-1', 'user-1');

    assert.deepEqual([...result].sort(), ['skill-a', 'skill-b']);
    assert.equal(grantWhere.companyId, 'company-1');
    assert.deepEqual(grantWhere.OR, [
      { granteeType: 'company', granteeId: 'company-1' },
      { granteeType: 'user', granteeId: 'user-1' },
      { granteeType: 'department', granteeId: { in: ['dep-1', 'dep-2'] } },
      { granteeType: 'role', granteeId: { in: ['role-1', 'role-2'] } },
    ]);
  });

  it('does not emit empty department or role grant clauses', async () => {
    let grantWhere: any;
    const prisma = {
      departmentMembership: { findMany: async () => [] },
      skillAccessGrant: {
        findMany: async (input: any) => { grantWhere = input.where; return []; },
      },
    };

    const result = await new SkillAccessRepository(prisma as any)
      .listGrantedSkillIds('company-1', 'user-1');

    assert.equal(result.size, 0);
    assert.deepEqual(grantWhere.OR, [
      { granteeType: 'company', granteeId: 'company-1' },
      { granteeType: 'user', granteeId: 'user-1' },
    ]);
  });

  it('reuses a principal-bound member scope instead of loading memberships again', async () => {
    let grantWhere: any;
    const prisma = {
      departmentMembership: {
        findMany: async () => { throw new Error('membership must not be loaded twice'); },
      },
      skillAccessGrant: {
        findMany: async (input: any) => { grantWhere = input.where; return []; },
      },
    };
    const scope = createMemberGrantScope({
      companyId: 'company-1',
      userId: 'user-1',
      departmentIds: ['dep-1', 'dep-1'],
      departmentRoleIds: ['role-1', 'role-1'],
      adminRole: null,
    });

    await new SkillAccessRepository(prisma as any)
      .listGrantedSkillIds('company-1', 'user-1', undefined, scope);

    assert.deepEqual(grantWhere.OR, [
      { granteeType: 'company', granteeId: 'company-1' },
      { granteeType: 'user', granteeId: 'user-1' },
      { granteeType: 'department', granteeId: { in: ['dep-1'] } },
      { granteeType: 'role', granteeId: { in: ['role-1'] } },
    ]);
  });

  it('rejects a member scope bound to another principal', async () => {
    const repository = new SkillAccessRepository({} as any);
    const scope = createMemberGrantScope({
      companyId: 'other-company',
      userId: 'user-1',
      departmentIds: [],
      departmentRoleIds: [],
      adminRole: null,
    });

    await assert.rejects(
      () => repository.listGrantedSkillIds('company-1', 'user-1', undefined, scope),
      /does not match the requested principal/,
    );
  });
});
