import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopToolAccessError, DesktopToolAccessService } from '../../src/application/desktop/desktop-tool-access.service.ts';

const ACTOR = { userId: 'user-manager', companyId: 'company-1', role: 'MEMBER' };

const REGISTERED = [
  { toolId: 'airtableRecords', name: 'Airtable Records', description: '', category: 'Airtable', domain: 'airtable', hitlRequired: false },
  { toolId: 'airtableSchema', name: 'Airtable Schema', description: '', category: 'Airtable', domain: 'airtable', hitlRequired: false },
  { toolId: 'memoryRecall', name: 'Memory Recall', description: '', category: 'Memory', domain: 'memory', hitlRequired: false },
];

function makeService(options: {
  companyRole?: string;
  isManager?: boolean;
  members?: Array<{ userId: string; roleId: string }>;
  roleRows?: Array<{ toolId: string; roleId: string; actionGroup: string }>;
  overrideRows?: Array<{ toolId: string; userId: string; actionGroup: string; allowed: boolean }>;
  toolActionRows?: Array<{ toolId: string; role: string; actionGroup: string; enabled: boolean }>;
  toolPermissionRows?: Array<{ toolId: string; role: string; enabled: boolean }>;
  managerApprovalJson?: unknown;
} = {}) {
  const prisma = {
    adminMembership: { findFirst: async () => ({ role: options.companyRole ?? 'MEMBER' }) },
    departmentMembership: {
      findFirst: async () => (options.isManager ?? true) ? { id: 'manager-membership' } : null,
      findMany: async () => options.members ?? [
        { userId: 'u-mgr', roleId: 'role-mgr' },
        { userId: 'u-analyst', roleId: 'role-analyst' },
        { userId: 'u-associate', roleId: 'role-associate' },
      ],
    },
    department: { findFirst: async ({ where }: any) => ({ id: where.id, name: 'Finance' }) },
    registeredTool: { findMany: async () => REGISTERED },
    departmentToolPermission: { findMany: async () => options.roleRows ?? [] },
    departmentUserToolOverride: { findMany: async () => options.overrideRows ?? [] },
    departmentAgentConfig: { findUnique: async () => options.managerApprovalJson === undefined ? null : { managerApprovalJson: options.managerApprovalJson } },
  } as any;

  return new DesktopToolAccessService({
    prisma,
    permissions: { resolve: async () => { throw new Error('coverage must not resolve per member'); } } as any,
    permissionWrites: {} as any,
    toolActionRepo: { getForCompany: async () => ({ ok: true as const, value: options.toolActionRows ?? [] }) } as any,
    toolPermRepo: { getForCompany: async () => ({ ok: true as const, value: options.toolPermissionRows ?? [] }) } as any,
    companyRoleRepo: { listByCompany: async () => ({ ok: true as const, value: [] }) } as any,
    connectionRepo: {} as any,
    toolRegistry: { byId: (toolId: string) => REGISTERED.some(t => t.toolId === toolId) ? {} : undefined } as any,
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child() { return this; } } as any,
  });
}

const forTool = (result: any, toolId: string) => result.tools.find((entry: any) => entry.tool.toolId === toolId);

describe('department tool coverage', () => {
  it('counts a person once they hold any action, not once per action', async () => {
    const result = await makeService({
      roleRows: [
        { toolId: 'airtableRecords', roleId: 'role-mgr', actionGroup: 'read' },
        { toolId: 'airtableRecords', roleId: 'role-mgr', actionGroup: 'create' },
        { toolId: 'airtableRecords', roleId: 'role-analyst', actionGroup: 'read' },
      ],
    }).coverage(ACTOR, 'dept-finance');

    assert.equal(result.totalPeople, 3);
    assert.equal(forTool(result, 'airtableRecords').peopleWithAccess, 2);
    assert.deepEqual(forTool(result, 'airtableRecords').actionsGranted, ['read', 'create']);
  });

  it('reports no one for a tool the department never turned on', async () => {
    const result = await makeService().coverage(ACTOR, 'dept-finance');
    assert.equal(forTool(result, 'airtableSchema').peopleWithAccess, 0);
    assert.deepEqual(forTool(result, 'airtableSchema').actionsGranted, []);
  });

  it('lets a personal exception add someone their group never had', async () => {
    const result = await makeService({
      roleRows: [{ toolId: 'airtableRecords', roleId: 'role-mgr', actionGroup: 'read' }],
      overrideRows: [{ toolId: 'airtableRecords', userId: 'u-associate', actionGroup: 'create', allowed: true }],
    }).coverage(ACTOR, 'dept-finance');

    assert.equal(forTool(result, 'airtableRecords').peopleWithAccess, 2);
    assert.equal(forTool(result, 'airtableRecords').exceptionCount, 1);
  });

  it('lets a personal exception take access away from someone their group has', async () => {
    const result = await makeService({
      roleRows: [
        { toolId: 'airtableRecords', roleId: 'role-mgr', actionGroup: 'read' },
        { toolId: 'airtableRecords', roleId: 'role-analyst', actionGroup: 'read' },
      ],
      overrideRows: [{ toolId: 'airtableRecords', userId: 'u-analyst', actionGroup: 'read', allowed: false }],
    }).coverage(ACTOR, 'dept-finance');

    assert.equal(forTool(result, 'airtableRecords').peopleWithAccess, 1);
  });

  it('names the actions the company ceiling is holding down for members', async () => {
    const result = await makeService({
      toolPermissionRows: [{ toolId: 'airtableSchema', role: 'MEMBER', enabled: false }],
      toolActionRows: [{ toolId: 'airtableRecords', role: 'MEMBER', actionGroup: 'delete', enabled: false }],
    }).coverage(ACTOR, 'dept-finance');

    assert.deepEqual(forTool(result, 'airtableRecords').blockedActions, ['delete']);
    assert.deepEqual(forTool(result, 'airtableSchema').blockedActions, ['read', 'create', 'update', 'delete']);
  });

  it('reports which actions the department gates behind approval', async () => {
    const result = await makeService({
      managerApprovalJson: {
        enabled: true,
        requiredActions: [{ toolId: 'airtableRecords', actions: ['delete', 'notAnAction'] }],
      },
    }).coverage(ACTOR, 'dept-finance');

    assert.deepEqual(forTool(result, 'airtableRecords').approvalActions, ['delete']);
    assert.deepEqual(forTool(result, 'airtableSchema').approvalActions, []);
  });

  it('ignores an approval policy that is switched off', async () => {
    const result = await makeService({
      managerApprovalJson: { enabled: false, requiredActions: [{ toolId: 'airtableRecords', actions: ['delete'] }] },
    }).coverage(ACTOR, 'dept-finance');

    assert.deepEqual(forTool(result, 'airtableRecords').approvalActions, []);
  });

  it('leaves fixed-policy tools out — there is nothing to configure on them', async () => {
    const result = await makeService().coverage(ACTOR, 'dept-finance');
    assert.equal(forTool(result, 'memoryRecall'), undefined);
  });

  it('lets a company admin read a department they do not manage', async () => {
    const result = await makeService({ companyRole: 'COMPANY_ADMIN', isManager: false }).coverage(ACTOR, 'dept-finance');
    assert.equal(result.department.name, 'Finance');
  });

  it('refuses a member who manages nothing', async () => {
    await assert.rejects(
      () => makeService({ companyRole: 'MEMBER', isManager: false }).coverage(ACTOR, 'dept-finance'),
      (error: unknown) => error instanceof DesktopToolAccessError && error.message === 'forbidden',
    );
  });
});
