import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DepartmentAdminService, memberTemplateGrants } from '../../src/application/departments/department-admin.service.ts';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from '../../src/application/skills/zoho-finance-system-skills.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as any;

function makeService() {
  let roleWrites = 0;
  let memberWrites = 0;
  const service = new DepartmentAdminService({
    prisma: {
      department: { findFirst: async () => ({ id: 'dept-1', companyId: 'company-1', name: 'Ops', slug: 'ops' }) },
      departmentRole: { findFirst: async () => ({ id: 'role-1', departmentId: 'dept-1', slug: 'MEMBER', name: 'Member' }) },
      departmentToolPermission: { upsert: async () => { roleWrites++; return {}; } },
      departmentUserToolOverride: { upsert: async () => { memberWrites++; return {}; } },
    } as any,
    logger,
    permissions: { invalidateDept: async () => {}, invalidateCompany: async () => {}, resolve: async () => { throw new Error('unused'); }, canInvoke: async () => { throw new Error('unused'); } } as any,
  });
  return { service, writes: () => ({ roleWrites, memberWrites }) };
}

describe('DepartmentAdminService fixed policy', () => {
  it('does not seed System Memory Recall into MEMBER templates', () => {
    assert.equal(memberTemplateGrants().some(grant => grant.toolId === 'memoryRecall'), false);
  });

  it('rejects legacy role and member Memory Recall rows before persistence', async () => {
    const { service, writes } = makeService();
    const role = await service.updateRolePermission('dept-1', 'company-1', 'role-1', 'memoryRecall', 'read', true, 'actor-1');
    const member = await service.updateUserOverride('dept-1', 'company-1', 'user-1', 'memoryRecall', 'read', true, 'actor-1');
    assert.equal(role.ok, false);
    assert.equal(member.ok, false);
    assert.equal(writes().roleWrites, 0);
    assert.equal(writes().memberWrites, 0);
  });

  // OMS was classified a fixed 'system' tool, so this write path answered
  // "Fixed-policy tool cannot be configured: omsSiteData" and a company admin
  // could not grant it to anyone, themselves included.
  it('lets an admin grant OMS Site Data to a department role', async () => {
    const { service, writes } = makeService();
    const role = await service.updateRolePermission('dept-1', 'company-1', 'role-1', 'omsSiteData', 'read', true, 'actor-1');

    assert.equal(role.ok, true);
    assert.equal(writes().roleWrites, 1);
  });

  it('does not seed OMS Site Data into MEMBER templates', () => {
    assert.equal(memberTemplateGrants().some(grant => grant.toolId === 'omsSiteData'), false);
  });

  it('provisions the canonical Zoho recipes when a Finance department is created', async () => {
    const createdSkillSlugs: string[] = [];
    let roleIndex = 0;
    const finance = { id: 'dept-finance', companyId: 'company-1', name: 'Finance', slug: 'finance', status: 'active' };
    const tx = {
      department: {
        create: async () => finance,
        findMany: async () => [finance],
      },
      departmentRole: {
        create: async ({ data }: any) => ({ id: `role-${++roleIndex}`, ...data }),
      },
      departmentAgentConfig: { create: async () => ({}) },
      departmentToolPermission: { createMany: async () => ({ count: 1 }) },
      skill: {
        findFirst: async () => null,
        findMany: async () => [],
        create: async ({ data }: any) => {
          createdSkillSlugs.push(data.slug);
          return { ...data, revision: 1, createdBy: null, updatedBy: null };
        },
      },
      skillRoute: {
        deleteMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 1 }),
      },
      skillVersion: { upsert: async () => ({}) },
      skillRegistryRevision: { upsert: async () => ({}) },
      skillAccessGrant: { upsert: async () => ({}) },
    };
    const service = new DepartmentAdminService({
      prisma: {
        department: { findFirst: async () => null },
        $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
      } as any,
      logger,
    } as any);

    const result = await service.createDepartment('company-1', 'actor-1', { name: 'Finance' });

    assert.equal(result.ok, true);
    assert.deepEqual(
      createdSkillSlugs,
      ZOHO_FINANCE_SYSTEM_SKILLS.map(skill => skill.slug),
    );
  });

  it('invalidates the exact department permission cache after membership changes', async () => {
    const invalidations: string[] = [];
    const service = new DepartmentAdminService({
      prisma: {
        department: { findFirst: async () => ({ id: 'dept-1', companyId: 'company-1', name: 'Ops', slug: 'ops' }) },
        adminMembership: { findFirst: async () => ({ id: 'workspace-membership' }) },
        departmentRole: { findFirst: async () => ({ id: 'role-1', slug: 'MEMBER' }) },
        departmentMembership: {
          upsert: async () => ({
            id: 'membership-1', userId: 'user-1', roleId: 'role-1',
            user: { name: 'Member', email: 'member@example.com' },
            role: { slug: 'MEMBER', name: 'Member' }, status: 'active',
            createdAt: new Date(), updatedAt: new Date(),
          }),
          delete: async () => ({}),
        },
      } as any,
      logger,
      permissions: { invalidateDept: async (companyId: string, departmentId: string) => { invalidations.push(`${companyId}:${departmentId}`); } } as any,
    });

    const saved = await service.upsertMembership('dept-1', 'company-1', { userId: 'user-1', roleId: 'role-1' });
    const removed = await service.removeMembership('dept-1', 'company-1', 'user-1');
    assert.equal(saved.ok, true);
    assert.equal(removed.ok, true);
    assert.deepEqual(invalidations, ['company-1:dept-1', 'company-1:dept-1']);
  });
});
