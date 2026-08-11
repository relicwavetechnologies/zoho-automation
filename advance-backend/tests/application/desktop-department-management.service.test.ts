import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopDepartmentManagementError,
  DesktopDepartmentManagementService,
} from '../../src/application/desktop/desktop-department-management.service.ts';

const actor = { userId: 'manager-1', companyId: 'company-1' };

const roles = [
  { id: 'manager-role', name: 'Manager', slug: 'MANAGER', isSystem: true, isDefault: false, zohoReadScope: 'personalized' },
  { id: 'member-role', name: 'Member', slug: 'MEMBER', isSystem: true, isDefault: true, zohoReadScope: 'personalized' },
  { id: 'analyst-role', name: 'Analyst', slug: 'ANALYST', isSystem: false, isDefault: false, zohoReadScope: 'personalized' },
];

function detail(overrides: any = {}) {
  return {
    department: { id: 'finance', companyId: 'company-1', name: 'Finance', slug: 'finance', description: null, status: 'active', createdAt: '', updatedAt: '' },
    roles,
    memberships: [
      { id: 'manager-membership', userId: 'manager-1', name: 'Manager', email: 'manager@example.com', roleId: 'manager-role', roleSlug: 'MANAGER', roleName: 'Manager', status: 'active', createdAt: '', updatedAt: '' },
      { id: 'member-membership', userId: 'member-1', name: 'Member', email: 'member@example.com', roleId: 'member-role', roleSlug: 'MEMBER', roleName: 'Member', status: 'active', createdAt: '', updatedAt: '' },
    ],
    ...overrides,
  };
}

function makeService(options: { companyRole?: string; managedDepartment?: string; revokeOnSecondCheck?: boolean; targetRole?: string; targetStatus?: string; approvalJson?: unknown } = {}) {
  let managerChecks = 0;
  const audits: any[] = [];
  const calls: any[] = [];
  const prisma = {
    adminMembership: { findFirst: async () => ({ id: 'workspace-membership', role: options.companyRole ?? 'MEMBER' }) },
    departmentMembership: {
      findFirst: async ({ where }: any) => {
        if (!where.role?.slug) {
          return options.targetRole ? { role: { slug: options.targetRole }, status: options.targetStatus ?? 'active' } : null;
        }
        managerChecks++;
        const permitted = (options.managedDepartment ?? 'finance') === where.departmentId && !(options.revokeOnSecondCheck && managerChecks >= 2);
        return permitted ? { id: 'manager-membership' } : null;
      },
    },
    departmentAgentConfig: {
      findFirst: async () => (options.approvalJson === undefined ? null : { id: 'cfg-1', managerApprovalJson: options.approvalJson }),
      update: async () => ({}),
    },
  } as any;
  const deptAdmin = {
    getDepartmentDetail: async () => ({ ok: true as const, value: detail() }),
    searchCandidates: async () => ({ ok: true as const, value: [
      { channelIdentityId: 'active', userId: 'active-user', isWorkspaceMember: true, isAlreadyAssigned: false, larkSourceRoles: [] },
      { channelIdentityId: 'inactive', isWorkspaceMember: false, isAlreadyAssigned: false, larkSourceRoles: [] },
    ] }),
    createRole: async (...args: any[]) => { calls.push(['createRole', ...args]); return { ok: true as const, value: { id: 'new-role', name: args[2].name, slug: args[2].slug, zohoReadScope: args[2].zohoReadScope } }; },
    updateRole: async (...args: any[]) => { calls.push(['updateRole', ...args]); return { ok: true as const, value: { id: args[2], name: args[3].name, slug: 'ANALYST', isDefault: false, zohoReadScope: 'personalized' } }; },
    deleteRole: async (...args: any[]) => { calls.push(['deleteRole', ...args]); return { ok: true as const, value: { deleted: true } }; },
    upsertMembership: async (...args: any[]) => { calls.push(['upsertMembership', ...args]); return { ok: true as const, value: detail().memberships[1] }; },
    removeMembership: async (...args: any[]) => { calls.push(['removeMembership', ...args]); return { ok: true as const, value: { deleted: true } }; },
  } as any;
  const service = new DesktopDepartmentManagementService({
    prisma,
    departmentAdminService: deptAdmin,
    auditService: { record: (entry: any) => audits.push(entry) } as any,
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child() { return this; } } as any,
    permissions: { invalidateDept: async () => {} } as any,
  });
  return { service, calls, audits };
}

describe('DesktopDepartmentManagementService', () => {
  it('allows only an active Manager of the exact department', async () => {
    const { service } = makeService({ managedDepartment: 'finance' });
    await service.snapshot(actor, 'finance');
    await assert.rejects(
      () => service.snapshot(actor, 'sales'),
      (error: unknown) => error instanceof DesktopDepartmentManagementError && error.code === 'forbidden',
    );
  });

  it('lets a company admin read a department they do not personally manage', async () => {
    const { service } = makeService({ companyRole: 'COMPANY_ADMIN', managedDepartment: 'finance' });
    await service.snapshot(actor, 'sales');
  });

  it('returns unavailable directory candidates with their eligibility context intact', async () => {
    const { service } = makeService();
    const candidates = await service.searchCandidates(actor, 'finance', 'a');
    assert.deepEqual(candidates.map(candidate => candidate.channelIdentityId), ['active', 'inactive']);
    assert.equal(candidates[1]?.isWorkspaceMember, false);
  });

  it('forces manager-created roles to personalized Zoho visibility and audits the write', async () => {
    const { service, calls, audits } = makeService();
    const role = await service.createRole(actor, 'finance', { name: 'Analyst', slug: 'analyst' });
    assert.equal(role.zohoReadScope, 'personalized');
    assert.equal(calls[0][3].zohoReadScope, 'personalized');
    assert.equal(audits[0].action, 'department_manager.role.created');
  });

  it('does not let managers alter built-in roles or grant/remove the Manager role', async () => {
    const { service, calls } = makeService();
    await assert.rejects(
      () => service.updateRole(actor, 'finance', 'manager-role', { name: 'Renamed' }),
      (error: unknown) => error instanceof DesktopDepartmentManagementError && error.code === 'forbidden',
    );
    await assert.rejects(
      () => service.upsertMembership(actor, 'finance', { userId: 'member-1', roleId: 'manager-role' }),
      (error: unknown) => error instanceof DesktopDepartmentManagementError && error.code === 'forbidden',
    );
    const managerTarget = makeService({ targetRole: 'MANAGER' });
    await assert.rejects(
      () => managerTarget.service.removeMembership(actor, 'finance', 'manager-1'),
      (error: unknown) => error instanceof DesktopDepartmentManagementError && error.code === 'forbidden',
    );
    assert.equal(calls.length, 0);
    assert.equal(managerTarget.calls.length, 0);
  });

  it('does not reactivate an inactive former Manager into an ordinary role', async () => {
    const { service, calls } = makeService({ targetRole: 'MANAGER', targetStatus: 'inactive' });
    await assert.rejects(
      () => service.upsertMembership(actor, 'finance', { userId: 'former-manager-1', roleId: 'member-role' }),
      (error: unknown) => error instanceof DesktopDepartmentManagementError && error.code === 'forbidden',
    );
    assert.equal(calls.length, 0);
  });

  it('revalidates manager authority immediately before persistence', async () => {
    const { service, calls } = makeService({ revokeOnSecondCheck: true });
    await assert.rejects(
      () => service.createRole(actor, 'finance', { name: 'Analyst', slug: 'analyst' }),
      (error: unknown) => error instanceof DesktopDepartmentManagementError && error.code === 'forbidden',
    );
    assert.equal(calls.length, 0);
  });

  /*
   * A policy can gate an action three ways, and the screen can only edit one of
   * them. Reading back only that one is what let Finance run with
   * `requiredToolIds: ['zohoCrm','zohoBooks']` while its manager was shown
   * "Nothing is gated" — and made their next toggle silently delete both gates,
   * because the screen sends the complete next state.
   */
  describe('reading a policy that uses the older selectors', () => {
    const gatedKeys = (policy: { requiredActions: { toolId: string; actions: string[] }[] }) =>
      policy.requiredActions.flatMap(e => e.actions.map(a => `${e.toolId}:${a}`)).sort();

    it('reports a legacy tool id as its concrete non-read actions', async () => {
      const { service } = makeService({
        approvalJson: { enabled: true, requiredActions: [], requiredToolIds: ['larkTask'], requiredActionGroups: [] },
      });

      const policy = await service.managerApprovalPolicy(actor, 'finance');

      assert.equal(policy.enabled, true);
      assert.deepEqual(gatedKeys(policy), ['larkTask:create', 'larkTask:delete', 'larkTask:update']);
    });

    it('never gates reading, whichever selector asked for it', async () => {
      const { service } = makeService({
        approvalJson: { enabled: true, requiredActions: [], requiredToolIds: ['larkTask'], requiredActionGroups: ['read'] },
      });

      const policy = await service.managerApprovalPolicy(actor, 'finance');

      assert.equal(gatedKeys(policy).some(key => key.endsWith(':read')), false);
    });

    it('merges the old and new forms without duplicating an action', async () => {
      const { service } = makeService({
        approvalJson: {
          enabled: true,
          requiredActions: [{ toolId: 'larkTask', actions: ['create'] }],
          requiredToolIds: ['larkTask'],
          requiredActionGroups: [],
        },
      });

      const policy = await service.managerApprovalPolicy(actor, 'finance');

      assert.equal(policy.requiredActions.length, 1);
      assert.deepEqual(gatedKeys(policy), ['larkTask:create', 'larkTask:delete', 'larkTask:update']);
    });

    it('leaves a policy that already uses exact actions untouched', async () => {
      const { service } = makeService({
        approvalJson: {
          enabled: false,
          requiredActions: [{ toolId: 'larkTask', actions: ['delete'] }],
          requiredToolIds: [],
          requiredActionGroups: [],
        },
      });

      const policy = await service.managerApprovalPolicy(actor, 'finance');

      assert.equal(policy.enabled, false);
      assert.deepEqual(gatedKeys(policy), ['larkTask:delete']);
    });
  });
});
