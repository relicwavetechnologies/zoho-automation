import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { provisionMailOpsPermissionsForExistingCompanies } from '../../src/application/skills/mail-ops-system-skills.ts';

interface RoleRow {
  id: string;
  departmentId: string;
  isSystem: boolean;
  companyId: string;
}

function fakeDb(options: {
  companies: string[];
  roles: RoleRow[];
  decidedRoleIds?: string[];
  activeAdmin?: (companyId: string) => string | undefined;
}) {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    company: {
      findMany: async () => options.companies.map(id => ({ id })),
    },
    adminMembership: {
      findFirst: async ({ where }: any) => {
        const userId = (options.activeAdmin ?? (() => 'admin-1'))(where.companyId);
        return userId ? { userId } : null;
      },
    },
    departmentRole: {
      findMany: async ({ where }: any) =>
        options.roles
          .filter(role => role.companyId === where.department.companyId)
          .filter(role => (where.isSystem === undefined ? true : role.isSystem === where.isSystem))
          .map(role => ({ id: role.id, departmentId: role.departmentId })),
    },
    departmentToolPermission: {
      findMany: async ({ where }: any) =>
        (options.decidedRoleIds ?? [])
          .filter(roleId => where.roleId.in.includes(roleId))
          .map(roleId => ({ roleId })),
      createMany: async ({ data }: any) => {
        created.push(...data);
        return { count: data.length };
      },
    },
  };
  return { db: db as any, created };
}

const role = (id: string, departmentId: string, isSystem: boolean): RoleRow => ({
  id,
  departmentId,
  isSystem,
  companyId: 'company-1',
});

describe('provisionMailOpsPermissionsForExistingCompanies', () => {
  it('seeds the two system roles and never touches a hand-configured role', async () => {
    const { db, created } = fakeDb({
      companies: ['company-1'],
      roles: [
        role('role-member', 'dept-1', true),
        role('role-manager', 'dept-1', true),
        role('role-intern', 'dept-1', false),
      ],
    });

    const result = await provisionMailOpsPermissionsForExistingCompanies(db);

    assert.equal(result.roles, 2);
    assert.equal(result.created, 10); // two roles × five actions
    assert.deepEqual(
      [...new Set(created.map(row => row['roleId']))].sort(),
      ['role-manager', 'role-member'],
    );
  });

  it('leaves a role alone once someone has decided about this tool', async () => {
    const { db, created } = fakeDb({
      companies: ['company-1'],
      roles: [role('role-member', 'dept-1', true), role('role-manager', 'dept-1', true)],
      decidedRoleIds: ['role-member'],
    });

    const result = await provisionMailOpsPermissionsForExistingCompanies(db);

    assert.equal(result.alreadyDecided, 1);
    assert.equal(result.created, 5);
    assert.deepEqual([...new Set(created.map(row => row['roleId']))], ['role-manager']);
  });

  it('skips a company between administrators instead of failing the whole run', async () => {
    const { db, created } = fakeDb({
      companies: ['company-0', 'company-1'],
      roles: [role('role-member', 'dept-1', true)],
      activeAdmin: companyId => (companyId === 'company-0' ? undefined : 'admin-1'),
    });

    const result = await provisionMailOpsPermissionsForExistingCompanies(db);

    assert.deepEqual(result.skippedCompanies, [
      { companyId: 'company-0', reason: 'no_active_administrator' },
    ]);
    assert.equal(created.length, 5);
  });

  it('invalidates each department it actually wrote to, and no others', async () => {
    const { db } = fakeDb({
      companies: ['company-1'],
      roles: [
        role('role-a', 'dept-1', true),
        role('role-b', 'dept-1', true),
        role('role-c', 'dept-2', true),
      ],
    });
    const invalidated: string[] = [];

    const result = await provisionMailOpsPermissionsForExistingCompanies(db, {
      invalidateDept: async (_companyId, departmentId) => {
        invalidated.push(departmentId);
      },
    });

    assert.deepEqual(invalidated.sort(), ['dept-1', 'dept-2']);
    assert.equal(result.departmentsInvalidated, 2);
  });

  it('writes nothing and invalidates nothing on a second run', async () => {
    const { db, created } = fakeDb({
      companies: ['company-1'],
      roles: [role('role-member', 'dept-1', true), role('role-manager', 'dept-1', true)],
      decidedRoleIds: ['role-member', 'role-manager'],
    });
    const invalidated: string[] = [];

    const result = await provisionMailOpsPermissionsForExistingCompanies(db, {
      invalidateDept: async (_companyId, departmentId) => {
        invalidated.push(departmentId);
      },
    });

    assert.equal(created.length, 0);
    assert.equal(result.created, 0);
    assert.deepEqual(invalidated, []);
  });
});
