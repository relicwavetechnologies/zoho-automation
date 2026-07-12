import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createDesktopDepartmentRoutes } from '../../src/http/desktop/desktop-departments.routes.ts';
import { DesktopDepartmentManagementError } from '../../src/application/desktop/desktop-department-management.service.ts';

const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child() { return this; } } as any;

function makeService(overrides: Record<string, any> = {}) {
  return {
    snapshot: async () => ({ department: { id: 'dept-1' }, roles: [], memberships: [] }),
    searchCandidates: async () => [],
    createRole: async () => ({ id: 'role-1', name: 'Analyst', slug: 'ANALYST', zohoReadScope: 'personalized' }),
    updateRole: async () => ({ id: 'role-1', name: 'Analyst', slug: 'ANALYST', isDefault: false, zohoReadScope: 'personalized' }),
    deleteRole: async () => ({ deleted: true }),
    upsertMembership: async () => ({ id: 'membership-1' }),
    removeMembership: async () => ({ deleted: true }),
    ...overrides,
  } as any;
}

async function callRoute(
  service: any,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  const router = createDesktopDepartmentRoutes({ prisma: {} as any, memberJwtSecret: 'secret', logger, service });
  return new Promise((resolve) => {
    let status = 200;
    const req = { method, path, params: {}, query: opts.query ?? {}, body: opts.body ?? {} } as unknown as Request;
    const res = {
      locals: { userId: 'manager-1', companyId: 'company-1' },
      status: (next: number) => { status = next; return res; },
      json: (body: unknown) => { resolve({ status, body }); return res; },
    } as unknown as Response;
    const next = (error?: unknown) => { resolve({ status: 500, body: error }); };
    const layer = (router as any).stack.find((entry: any) => {
      if (!entry.route || !entry.route.methods[method.toLowerCase()]) return false;
      const pattern = entry.route.path.replace(/:([^/]+)/g, '([^/]+)');
      return new RegExp(`^${pattern}$`).test(path);
    });
    if (!layer) throw new Error(`Route not found: ${method} ${path}`);
    const names: string[] = [];
    const pattern = layer.route.path.replace(/:([^/]+)/g, (_: string, name: string) => { names.push(name); return '([^/]+)'; });
    const match = path.match(new RegExp(`^${pattern}$`))!;
    req.params = Object.fromEntries(names.map((name, index) => [name, match[index + 1]])) as any;
    const handler = layer.route.stack.at(-1).handle;
    Promise.resolve(handler(req, res, next)).catch(next);
  });
}

describe('desktop department management routes', () => {
  it('exposes only department-scoped role creation and does not accept Zoho scope from the client', async () => {
    let captured: any;
    const service = makeService({ createRole: async (...args: any[]) => { captured = args; return { id: 'role-1', name: 'Analyst', slug: 'ANALYST', zohoReadScope: 'personalized' }; } });
    const response = await callRoute(service, 'POST', '/departments/dept-1/roles', { body: { name: 'Analyst', slug: 'ANALYST', zohoReadScope: 'show_all' } });
    assert.equal(response.status, 400);
    assert.equal(captured, undefined);
  });

  it('forwards a valid membership assignment under the authenticated member actor', async () => {
    let captured: any;
    const service = makeService({ upsertMembership: async (...args: any[]) => { captured = args; return { id: 'membership-1' }; } });
    const response = await callRoute(service, 'PUT', '/departments/dept-1/memberships', { body: { userId: 'user-2', roleId: 'role-2' } });
    assert.equal(response.status, 200);
    assert.deepEqual(captured, [{ userId: 'manager-1', companyId: 'company-1' }, 'dept-1', { userId: 'user-2', roleId: 'role-2' }]);
  });

  it('rejects malformed candidate searches before they reach the service', async () => {
    let called = false;
    const response = await callRoute(makeService({ searchCandidates: async () => { called = true; return []; } }), 'GET', '/departments/dept-1/candidates');
    assert.equal(response.status, 400);
    assert.equal(called, false);
  });

  it('maps manager denial to 403 rather than leaking the admin route', async () => {
    const response = await callRoute(makeService({ removeMembership: async () => { throw new DesktopDepartmentManagementError('forbidden', 'not allowed'); } }), 'DELETE', '/departments/dept-1/memberships/user-2');
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'forbidden');
  });
});
