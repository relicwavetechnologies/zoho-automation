import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopToolAccessError, DesktopToolAccessService } from '../../src/application/desktop/desktop-tool-access.service.ts';

/**
 * A company admin governs every department, including the ones they are not
 * personally a manager of.
 *
 * The read and write paths had drifted apart: reading a department's coverage
 * allowed admin-or-manager, while listing departments and opening a tool inside
 * one demanded MANAGER membership. A company admin who managed Finance and
 * nothing else therefore could not see Marketing at all — and if the UI showed
 * it anyway, every switch answered 403.
 */

const ADMIN = { userId: 'user-admin', companyId: 'company-1', role: 'MEMBER' };
const TOOL = { toolId: 'semrush', name: 'Semrush', description: '', category: 'SEO', domain: 'semrush', hitlRequired: false };

const ALL_DEPARTMENTS = [
  { id: 'dept-finance', name: 'Finance' },
  { id: 'dept-marketing', name: 'Marketing' },
  { id: 'dept-sales', name: 'Sales' },
];

function makeService(options: { companyRole?: string; managerOf?: string[] } = {}) {
  const managerOf = new Set(options.managerOf ?? []);
  const prisma = {
    adminMembership: { findFirst: async () => ({ role: options.companyRole ?? 'MEMBER' }) },
    department: {
      findMany: async () => ALL_DEPARTMENTS,
      findFirst: async ({ where }: any) => ALL_DEPARTMENTS.find(department => department.id === where.id) ?? null,
    },
    departmentMembership: {
      // The actor belongs to Finance only.
      findMany: async ({ where }: any) => where.departmentId
        ? [{ userId: 'user-analyst', user: { name: 'Analyst', email: 'analyst@example.com' }, roleId: 'role-1' }]
        : [{ departmentId: 'dept-finance', department: { name: 'Finance' }, role: { slug: managerOf.has('dept-finance') ? 'MANAGER' : 'MEMBER' } }],
      findFirst: async ({ where }: any) => where.role?.slug === 'MANAGER'
        ? (managerOf.has(where.departmentId) ? { id: 'manager-membership' } : null)
        : { id: 'target-membership' },
    },
    departmentRole: {
      findMany: async () => [{ id: 'role-1', name: 'Analyst', slug: 'ANALYST' }],
      findFirst: async () => ({ id: 'role-1' }),
    },
    registeredTool: {
      findMany: async () => [TOOL],
      findFirst: async () => TOOL,
    },
    departmentToolPermission: { findMany: async () => [] },
    departmentUserToolOverride: { findMany: async () => [] },
    departmentAgentConfig: { findUnique: async () => null },
  } as any;

  const writes: string[] = [];
  return {
    writes,
    service: new DesktopToolAccessService({
      prisma,
      permissions: {
        resolve: async () => ({ ok: true as const, value: { allowedActionsByTool: new Map([['semrush', new Set(['read'])]]) } }),
        invalidateCompany: async () => {},
        invalidateDept: async () => {},
      } as any,
      permissionWrites: {
        setDepartmentRoleAction: async (input: any) => {
          if (!await input.revalidate()) return { ok: false as const, reason: 'forbidden' };
          writes.push(`${input.departmentId}:${input.roleId}:${input.actionGroup}`);
          return { ok: true as const };
        },
      } as any,
      toolActionRepo: { getForCompany: async () => ({ ok: true as const, value: [] }) } as any,
      toolPermRepo: { getForCompany: async () => ({ ok: true as const, value: [] }) } as any,
      companyRoleRepo: { listByCompany: async () => ({ ok: true as const, value: [] }) } as any,
      connectionRepo: {
        listAccessibleGoogleConnections: async () => ({ ok: true as const, value: [] }),
        listAccessibleCanvaConnections: async () => ({ ok: true as const, value: [] }),
        listAccessibleZohoConnections: async () => ({ ok: true as const, value: [] }),
        listAccessibleLarkConnections: async () => ({ ok: true as const, value: [] }),
        listAccessibleAirtableConnections: async () => ({ ok: true as const, value: [] }),
      } as any,
      toolRegistry: { byId: (toolId: string) => toolId === 'semrush' ? {} : undefined } as any,
      logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child() { return this; } } as any,
    }),
  };
}

const departmentScopeNames = (inventory: any) => inventory.tools[0].managementScopes
  .filter((scope: any) => scope.kind === 'department')
  .map((scope: any) => scope.department.name);

describe('company admin governance of departments', () => {
  it('lists every department in the company, not only the ones they manage', async () => {
    const inventory = await makeService({ companyRole: 'COMPANY_ADMIN' }).service.inventory(ADMIN);
    assert.deepEqual(departmentScopeNames(inventory), ['Finance', 'Marketing', 'Sales']);
  });

  it('opens a tool in a department the admin does not manage', async () => {
    const snapshot = await makeService({ companyRole: 'COMPANY_ADMIN' }).service
      .snapshot(ADMIN, 'semrush', { kind: 'department', departmentId: 'dept-marketing' });

    assert.equal(snapshot.scope.kind, 'department');
  });

  it('lets the admin actually change access there, not just look at it', async () => {
    // Listing a department you cannot write to is worse than not listing it:
    // every switch answers 403 on click.
    const { service, writes } = makeService({ companyRole: 'COMPANY_ADMIN' });
    await service.setDepartmentRole(ADMIN, 'semrush', 'dept-marketing', 'role-1', 'read', true);

    assert.deepEqual(writes, ['dept-marketing:role-1:read']);
  });

  it('reads coverage for a department the admin does not manage', async () => {
    const coverage = await makeService({ companyRole: 'COMPANY_ADMIN' }).service.coverage(ADMIN, 'dept-sales');
    assert.equal(coverage.department.name, 'Sales');
  });

  it('still limits a plain manager to the departments they manage', async () => {
    const { service } = makeService({ companyRole: 'MEMBER', managerOf: ['dept-finance'] });
    const inventory = await service.inventory(ADMIN);

    assert.deepEqual(departmentScopeNames(inventory), ['Finance']);
    await assert.rejects(
      () => service.snapshot(ADMIN, 'semrush', { kind: 'department', departmentId: 'dept-marketing' }),
      (error: unknown) => error instanceof DesktopToolAccessError && error.message === 'forbidden',
    );
  });

  it('refuses a member who manages nothing and is not an admin', async () => {
    const { service } = makeService({ companyRole: 'MEMBER' });
    await assert.rejects(
      () => service.setDepartmentRole(ADMIN, 'semrush', 'dept-finance', 'role-1', 'read', true),
      (error: unknown) => error instanceof DesktopToolAccessError && error.message === 'forbidden',
    );
  });
});
