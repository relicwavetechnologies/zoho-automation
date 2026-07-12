import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopToolAccessError, DesktopToolAccessService } from '../../src/application/desktop/desktop-tool-access.service.ts';
import { PermissionWriteService } from '../../src/application/permissions/permission-write.service.ts';

const actor = { userId: 'user-1', companyId: 'company-1', role: 'MEMBER' };
const tool = { toolId: 'larkTask', name: 'Lark Tasks', description: 'Tasks', category: 'Lark', domain: 'lark', hitlRequired: false };

function allowed(actions: string[]) {
  return { ok: true as const, value: { allowedActionsByTool: new Map(actions.length ? [['larkTask' as any, new Set(actions)]] : []) } };
}

function makeService(options: {
  companyRole?: string;
  managerDepartments?: string[];
  onWrite?: () => void;
  registeredTools?: Array<typeof tool>;
  memberships?: Array<{ departmentId: string; department: { name: string }; role: { slug: string } }>;
  runtimeToolIds?: string[];
  roleRows?: Array<{ roleId: string; actionGroup: string; allowed: boolean }>;
  revokeManagerOnSecondCheck?: boolean;
  revokeCompanyMembershipOnSecondCheck?: boolean;
  toolActionRows?: Array<{ toolId: string; role: string; actionGroup: string; enabled: boolean }>;
  toolPermissionRows?: Array<{ toolId: string; role: string; enabled: boolean }>;
  companyRoles?: Array<{ id: string; companyId: string; slug: string; displayName: string; isBuiltIn: boolean }>;
  logger?: { error: (event: string, data?: Record<string, unknown>) => void };
  resolve?: (query: any) => Promise<any>;
  overrideRows?: Array<{ userId: string; actionGroup: string; allowed: boolean }>;
} = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const invalidations: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const companyRole = options.companyRole ?? 'MEMBER';
  const managers = new Set(options.managerDepartments ?? ['ops']);
  let managerChecks = 0;
  let companyMembershipChecks = 0;
  const prisma = {
    adminMembership: { findFirst: async () => {
      companyMembershipChecks++;
      return options.revokeCompanyMembershipOnSecondCheck && companyMembershipChecks >= 2 ? null : { role: companyRole };
    } },
    registeredTool: {
      findMany: async () => options.registeredTools ?? [tool, { ...tool, toolId: 'memoryRecall', name: 'Memory Recall' }, { ...tool, toolId: 'runCommand', name: 'Terminal' }],
      findFirst: async ({ where }: any) => where.toolId === 'larkTask' ? tool : null,
    },
    departmentMembership: {
      findMany: async ({ where }: any) => where.departmentId
        ? [{ userId: 'user-1', user: { name: 'User', email: 'user@example.com' }, roleId: 'role-ops' }]
        : options.memberships ?? [
          { departmentId: 'ops', department: { name: 'Ops' }, role: { slug: managers.has('ops') ? 'MANAGER' : 'MEMBER' } },
          { departmentId: 'outreach', department: { name: 'Outreach' }, role: { slug: managers.has('outreach') ? 'MANAGER' : 'MEMBER' } },
        ],
      findFirst: async ({ where }: any) => where.role?.slug === 'MANAGER'
        ? (() => {
          managerChecks++;
          return managers.has(where.departmentId) && !(options.revokeManagerOnSecondCheck && managerChecks >= 2)
            ? { id: 'manager-membership' } : null;
        })()
        : { id: 'target-membership' },
    },
    departmentRole: {
      findFirst: async () => ({ id: 'role-ops' }),
      findMany: async () => [{ id: 'role-ops', name: 'Operator', slug: 'OPERATOR' }],
    },
    department: { findFirst: async ({ where }: any) => ({ id: where.id, name: where.id === 'ops' ? 'Ops' : 'Outreach' }) },
    departmentToolPermission: { findMany: async () => options.roleRows ?? [] },
    departmentUserToolOverride: { findMany: async () => options.overrideRows ?? [] },
  } as any;
  const permissions = {
    resolve: options.resolve ?? (async (query: any) => !query.departmentId
      ? allowed(['read'])
      : query.departmentId === 'ops' ? allowed(['create']) : allowed(['update'])),
    invalidateCompany: async (id: string) => { invalidations.push(`company:${id}`); },
    invalidateDept: async (companyId: string, departmentId: string) => { invalidations.push(`dept:${companyId}:${departmentId}`); },
  } as any;
  const toolActionRepo = {
    getForCompany: async () => ({ ok: true as const, value: options.toolActionRows ?? [] }),
    upsert: async (...args: any[]) => { writes.push({ scope: 'company', args }); options.onWrite?.(); return { ok: true as const, value: {} }; },
  } as any;
  const toolPermRepo = {
    getForCompany: async () => ({ ok: true as const, value: options.toolPermissionRows ?? [] }),
  } as any;
  const deptToolPermRepo = {
    upsert: async (...args: any[]) => { writes.push({ scope: 'department-role', args }); options.onWrite?.(); return { ok: true as const, value: {} }; },
  } as any;
  const deptUserOverrideRepo = {
    upsert: async (...args: any[]) => { writes.push({ scope: 'department-member', args }); return { ok: true as const, value: {} }; },
  } as any;
  const permissionWrites = new PermissionWriteService({
    toolActionRepo, deptToolPermRepo, deptUserOverrideRepo, permissions,
    auditService: { record: (entry: Record<string, unknown>) => audits.push(entry) } as any,
    toolRegistry: {
      byId: (toolId: string) => (options.runtimeToolIds ?? ['larkTask', 'memoryRecall', 'runCommand']).includes(toolId) ? {} : undefined,
    } as any,
  });
  const service = new DesktopToolAccessService({
    prisma, permissions, permissionWrites, toolActionRepo, toolPermRepo,
    companyRoleRepo: {
      listByCompany: async () => ({ ok: true as const, value: options.companyRoles ?? [] }),
    },
    connectionRepo: {
      listAccessibleGoogleConnections: async () => ({ ok: true as const, value: [] }),
      listAccessibleZohoConnections: async () => ({ ok: true as const, value: [] }),
    } as any,
    toolRegistry: {
      byId: (toolId: string) => (options.runtimeToolIds ?? ['larkTask', 'memoryRecall', 'runCommand']).includes(toolId) ? {} : undefined,
    } as any,
    logger: options.logger ?? { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child() { return this; } } as any,
  });
  return { service, writes, invalidations, audits, managers };
}

describe('DesktopToolAccessService', () => {
  it('aggregates global and every active department origin, while keeping Local/System policy separate', async () => {
    const { service } = makeService({ managerDepartments: ['ops'] });
    const result = await service.inventory(actor);
    const lark = result.tools.find(entry => entry.tool.toolId === 'larkTask')!;
    assert.deepEqual(lark.origins, [
      { kind: 'global', allowedActions: ['read'] },
      { kind: 'department', department: { id: 'ops', name: 'Ops' }, allowedActions: ['create'] },
      { kind: 'department', department: { id: 'outreach', name: 'Outreach' }, allowedActions: ['update'] },
    ]);
    assert.deepEqual(lark.managementScopes, [{ kind: 'department', department: { id: 'ops', name: 'Ops' } }]);
    assert.equal(result.tools.find(entry => entry.tool.toolId === 'memoryRecall')?.origins[0].kind, 'system');
    assert.equal(result.tools.find(entry => entry.tool.toolId === 'runCommand')?.origins[0].kind, 'local');
  });

  it('denies cross-department writes and rechecks a stale manager before writing', async () => {
    const { service, writes, managers } = makeService({ managerDepartments: ['ops'] });
    await assert.rejects(
      () => service.setDepartmentRole(actor, 'larkTask', 'outreach', 'role-ops', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'forbidden',
    );
    await service.snapshot(actor, 'larkTask', { kind: 'department', departmentId: 'ops' });
    managers.delete('ops');
    await assert.rejects(
      () => service.setDepartmentRole(actor, 'larkTask', 'ops', 'role-ops', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'forbidden',
    );
    assert.equal(writes.length, 0);
  });

  it('performs a final department-manager revalidation at the write boundary', async () => {
    const { service, writes } = makeService({ managerDepartments: ['ops'], revokeManagerOnSecondCheck: true });
    await assert.rejects(
      () => service.setDepartmentRole(actor, 'larkTask', 'ops', 'role-ops', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'invalid',
    );
    assert.equal(writes.length, 0);
  });

  it('rejects a department write when company membership is revoked before the final writer recheck', async () => {
    const { service, writes } = makeService({ managerDepartments: ['ops'], revokeCompanyMembershipOnSecondCheck: true });
    await assert.rejects(
      () => service.setDepartmentRole(actor, 'larkTask', 'ops', 'role-ops', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'invalid',
    );
    assert.equal(writes.length, 0);
  });

  it('writes a permitted exact department action through cache invalidation and audit, but never permits fixed policy tools', async () => {
    const { service, writes, invalidations, audits } = makeService({ managerDepartments: ['ops'] });
    await service.setDepartmentRole(actor, 'larkTask', 'ops', 'role-ops', 'read', true);
    assert.equal(writes.length, 1);
    assert.deepEqual(invalidations, ['dept:company-1:ops']);
    assert.equal(audits[0].action, 'permission.set_dept_action');
    await service.setDepartmentMember(actor, 'larkTask', 'ops', 'user-1', 'create', false);
    assert.equal(writes[1].scope, 'department-member');
    assert.equal(audits[1].action, 'permission.set_dept_member_action');
    await assert.rejects(
      () => service.setDepartmentRole(actor, 'memoryRecall', 'ops', 'role-ops', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'invalid',
    );
  });

  it('returns each member action from PermissionService with inherited or explicit override provenance', async () => {
    const { service } = makeService({
      overrideRows: [{ userId: 'user-1', actionGroup: 'delete', allowed: false }],
      roleRows: [{ roleId: 'role-ops', actionGroup: 'create', allowed: true }],
      resolve: async query => query.departmentId ? allowed(['create']) : allowed(['read']),
    });
    const snapshot = await service.snapshot(actor, 'larkTask', { kind: 'department', departmentId: 'ops' });
    if (snapshot.scope.kind !== 'department') throw new Error('expected department snapshot');

    assert.deepEqual(
      snapshot.memberActionStates.filter(action => action.userId === 'user-1'),
      [
        { userId: 'user-1', actionGroup: 'read', configuredAllowed: false, configuredProvenance: 'default', effectiveAllowed: false, effectiveBlockReason: null, storedOverride: null, provenance: 'inherited' },
        { userId: 'user-1', actionGroup: 'create', configuredAllowed: true, configuredProvenance: 'department_role', effectiveAllowed: true, effectiveBlockReason: null, storedOverride: null, provenance: 'inherited' },
        { userId: 'user-1', actionGroup: 'update', configuredAllowed: false, configuredProvenance: 'default', effectiveAllowed: false, effectiveBlockReason: null, storedOverride: null, provenance: 'inherited' },
        { userId: 'user-1', actionGroup: 'delete', configuredAllowed: false, configuredProvenance: 'member_override', effectiveAllowed: false, effectiveBlockReason: null, storedOverride: false, provenance: 'override' },
      ],
    );
  });

  it('keeps a member allow configured when a company action ceiling denies present access', async () => {
    const { service, writes } = makeService({
      companyRole: 'MEMBER',
      managerDepartments: ['ops'],
      overrideRows: [{ userId: 'user-1', actionGroup: 'create', allowed: true }],
      toolActionRows: [{ toolId: 'larkTask', role: 'MEMBER', actionGroup: 'create', enabled: false }],
      resolve: async () => allowed([]),
    });
    const snapshot = await service.snapshot(actor, 'larkTask', { kind: 'department', departmentId: 'ops' });
    if (snapshot.scope.kind !== 'department') throw new Error('expected department snapshot');
    assert.deepEqual(snapshot.memberActionStates.find(action => action.actionGroup === 'create'), {
      userId: 'user-1', actionGroup: 'create', configuredAllowed: true, configuredProvenance: 'member_override', effectiveAllowed: false,
      effectiveBlockReason: 'company_action_disabled', storedOverride: true, provenance: 'override',
    });
    assert.deepEqual(snapshot.roleActionStates.find(action => action.actionGroup === 'create'), {
      roleId: 'role-ops', actionGroup: 'create', configuredAllowed: false, configuredProvenance: 'default',
      companyPolicyStatus: 'company_action_blocks_all_current_members',
    });

    await service.setDepartmentMember(actor, 'larkTask', 'ops', 'user-1', 'create', false);
    assert.equal(writes.at(-1)?.scope, 'department-member');
  });

  it('restricts global action writes to a live company admin', async () => {
    const member = makeService({ companyRole: 'MEMBER' });
    await assert.rejects(
      () => member.service.setGlobal(actor, 'larkTask', 'MEMBER', 'read', false),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'forbidden',
    );
    const admin = makeService({ companyRole: 'COMPANY_ADMIN' });
    await admin.service.setGlobal({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', 'MEMBER', 'read', false);
    assert.equal(admin.writes.length, 1);
  });

  it('includes registered custom company roles in Global Tools and rejects arbitrary role strings', async () => {
    const customRole = { id: 'role-custom', companyId: 'company-1', slug: 'CUSTOM_ANALYST', displayName: 'Custom Analyst', isBuiltIn: false };
    const { service, writes } = makeService({ companyRole: 'COMPANY_ADMIN', companyRoles: [customRole] });
    const snapshot: any = await service.snapshot({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', { kind: 'global' });
    assert.ok(snapshot.roles.some((role: any) => role.role === 'CUSTOM_ANALYST'));
    await service.setGlobal({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', 'CUSTOM_ANALYST', 'read', false);
    assert.equal(writes.length, 1);
    await assert.rejects(
      () => service.setGlobal({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', 'ARBITRARY_ROLE', 'read', false),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'invalid',
    );
  });

  it('projects the authoritative company tool gate into global actions and department ceilings', async () => {
    const disabledRows = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'].map(role => ({ toolId: 'larkTask', role, enabled: false }));
    const global = makeService({
      companyRole: 'COMPANY_ADMIN',
      toolPermissionRows: disabledRows,
      toolActionRows: [
        { toolId: 'larkTask', role: 'MEMBER', actionGroup: 'read', enabled: false },
        { toolId: 'larkTask', role: 'MEMBER', actionGroup: 'create', enabled: true },
      ],
    });
    const globalSnapshot: any = await global.service.snapshot({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', { kind: 'global' });
    for (const role of globalSnapshot.roles) {
      assert.ok(role.actions.every((action: any) => action.effectiveAllowed === false && action.clampReason === 'company_tool_disabled'));
    }
    assert.deepEqual(globalSnapshot.roles.find((role: any) => role.role === 'MEMBER').actions, [
      { actionGroup: 'read', effectiveAllowed: false, storedAllowed: false, storedProvenance: 'override', clampReason: 'company_tool_disabled' },
      { actionGroup: 'create', effectiveAllowed: false, storedAllowed: true, storedProvenance: 'override', clampReason: 'company_tool_disabled' },
      { actionGroup: 'update', effectiveAllowed: false, storedAllowed: true, storedProvenance: 'default', clampReason: 'company_tool_disabled' },
      { actionGroup: 'delete', effectiveAllowed: false, storedAllowed: true, storedProvenance: 'default', clampReason: 'company_tool_disabled' },
    ]);

    const department = makeService({ managerDepartments: ['ops'], toolPermissionRows: disabledRows });
    const departmentSnapshot: any = await department.service.snapshot(actor, 'larkTask', { kind: 'department', departmentId: 'ops' });
    assert.ok(departmentSnapshot.companyCeiling.every((ceiling: any) => ceiling.actions.length === 0));

    const reenabled = makeService({
      companyRole: 'COMPANY_ADMIN',
      toolPermissionRows: ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'].map(role => ({ toolId: 'larkTask', role, enabled: true })),
    });
    const reenabledSnapshot: any = await reenabled.service.snapshot({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', { kind: 'global' });
    assert.ok(reenabledSnapshot.roles.every((role: any) => role.actions.every((action: any) => action.effectiveAllowed === true && action.storedAllowed === true && action.storedProvenance === 'default' && action.clampReason === null)));
  });

  it('reports a tool-gated member exception while preserving durable department writes', async () => {
    const disabledRows = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'].map(role => ({ toolId: 'larkTask', role, enabled: false }));
    const { service, writes } = makeService({
      companyRole: 'COMPANY_ADMIN',
      managerDepartments: ['ops'],
      toolPermissionRows: disabledRows,
      overrideRows: [{ userId: 'user-1', actionGroup: 'create', allowed: true }],
      resolve: async () => allowed([]),
    });
    const snapshot = await service.snapshot({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', { kind: 'department', departmentId: 'ops' });
    if (snapshot.scope.kind !== 'department') throw new Error('expected department snapshot');
    assert.deepEqual(snapshot.memberActionStates.find(action => action.actionGroup === 'create'), {
      userId: 'user-1', actionGroup: 'create', configuredAllowed: true, configuredProvenance: 'member_override', effectiveAllowed: false,
      effectiveBlockReason: 'company_tool_disabled', storedOverride: true, provenance: 'override',
    });
    assert.deepEqual(snapshot.roleActionStates.find(action => action.actionGroup === 'create'), {
      roleId: 'role-ops', actionGroup: 'create', configuredAllowed: false, configuredProvenance: 'default',
      companyPolicyStatus: 'company_tool_blocks_all_current_members',
    });
    await assert.rejects(
      () => service.setGlobal({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', 'MEMBER', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'invalid',
    );
    await service.setDepartmentRole({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', 'ops', 'role-ops', 'read', true);
    await service.setDepartmentMember({ ...actor, role: 'COMPANY_ADMIN' }, 'larkTask', 'ops', 'user-1', 'create', false);
    assert.deepEqual(writes.map(write => write.scope), ['department-role', 'department-member']);
  });

  it('bounds department permission resolution while preserving membership origin ordering', async () => {
    let active = 0;
    let maxActive = 0;
    const memberships = Array.from({ length: 11 }, (_, index) => ({
      departmentId: `dept-${index}`,
      department: { name: `Department ${String(index).padStart(2, '0')}` },
      role: { slug: 'MEMBER' },
    }));
    const { service } = makeService({
      memberships,
      resolve: async (query) => {
        if (!query.departmentId) return allowed(['read']);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return allowed(['read']);
      },
    });
    const result = await service.inventory(actor);
    const lark = result.tools.find(entry => entry.tool.toolId === 'larkTask')!;
    assert.ok(maxActive <= 4);
    assert.deepEqual(
      (lark.origins as any[]).filter(origin => origin.kind === 'department').map(origin => origin.department.id),
      memberships.map(membership => membership.departmentId),
    );
  });

  it('uses an explicit custom company-role tool gate when explaining member execution', async () => {
    const { service, writes } = makeService({
      companyRole: 'CUSTOM_ANALYST',
      managerDepartments: ['ops'],
      toolPermissionRows: [{ toolId: 'larkTask', role: 'CUSTOM_ANALYST', enabled: false }],
      resolve: async () => allowed([]),
    });
    const snapshot = await service.snapshot(actor, 'larkTask', { kind: 'department', departmentId: 'ops' });
    if (snapshot.scope.kind !== 'department') throw new Error('expected department snapshot');
    assert.equal(
      snapshot.memberActionStates.find(action => action.actionGroup === 'read')?.effectiveBlockReason,
      'company_tool_disabled',
    );
    await service.setDepartmentRole(actor, 'larkTask', 'ops', 'role-ops', 'read', true);
    await service.setDepartmentMember(actor, 'larkTask', 'ops', 'user-1', 'read', true);
    assert.deepEqual(writes.map(write => write.scope), ['department-role', 'department-member']);
  });

  it('fails inventory when any active department permission evaluation fails', async () => {
    const { service } = makeService({
      resolve: async query => query.departmentId ? { ok: false as const } : allowed(['read']),
    });
    await assert.rejects(
      () => service.inventory(actor),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'internal',
    );
  });

  it('excludes and refuses runtime-absent tools, and logs safe catalogue configuration errors', async () => {
    const errors: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const logger = { error: (event: string, data?: Record<string, unknown>) => errors.push({ event, data }) };
    const { service } = makeService({
      runtimeToolIds: ['memoryRecall', 'runCommand'],
      registeredTools: [tool, { ...tool, toolId: 'notClassified', name: 'Unclassified' }],
      logger,
    });
    const inventory = await service.inventory(actor);
    assert.equal(inventory.tools.some(entry => entry.tool.toolId === 'larkTask'), false);
    assert.equal(inventory.tools.some(entry => entry.tool.toolId === 'notClassified'), false);
    await assert.rejects(
      () => service.setDepartmentRole(actor, 'larkTask', 'ops', 'role-ops', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.code === 'invalid',
    );
    assert.deepEqual(errors, [
      { event: 'desktop.tools.catalogue.registry_mismatch', data: { toolId: 'larkTask', policyKind: 'configurable' } },
      { event: 'desktop.tools.catalogue.unclassified_registered_tool', data: { toolId: 'notClassified' } },
      { event: 'desktop.tools.catalogue.registry_mismatch', data: { toolId: 'larkTask', policyKind: 'configurable' } },
    ]);
  });
});
