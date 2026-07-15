import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SkillAccessRepository } from '../../src/infrastructure/persistence/skill-access.repository.ts';

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
});
