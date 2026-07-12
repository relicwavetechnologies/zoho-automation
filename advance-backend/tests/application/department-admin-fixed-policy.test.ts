import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DepartmentAdminService, memberTemplateGrants } from '../../src/application/departments/department-admin.service.ts';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as any;

function makeService() {
  let roleWrites = 0;
  let memberWrites = 0;
  const service = new DepartmentAdminService({
    prisma: {
      department: { findFirst: async () => ({ id: 'dept-1', companyId: 'company-1', name: 'Ops', slug: 'ops' }) },
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
});
