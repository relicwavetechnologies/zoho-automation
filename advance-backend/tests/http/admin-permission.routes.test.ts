import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminPermissionRoutes } from '../../src/http/admin/permission.routes.ts';
import type { AdminPermissionRouteDeps } from '../../src/http/admin/permission.routes.ts';
import type { ToolPermissionRow } from '../../src/infrastructure/persistence/tool-permission.repository.ts';
import type { ToolActionPermissionRow } from '../../src/infrastructure/persistence/tool-action-permission.repository.ts';
import type { DeptToolPermissionRow } from '../../src/infrastructure/persistence/department-tool-permission.repository.ts';
import { ok, err } from '../../src/shared/result.ts';
import { wrapInfra } from '../../src/shared/errors.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { Request, Response } from 'express';
import { PermissionWriteService } from '../../src/application/permissions/permission-write.service.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

/** Simulate an Express request/response cycle against a Router. */
async function callRoute(
  router: ReturnType<typeof createAdminPermissionRoutes>,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body: unknown = {},
  query: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};

    const req = {
      method,
      path,
      params: {},
      query,
      body,
      headers: {},
    } as unknown as Request;

    const res = {
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = () => resolve({ status: 404, body: { error: 'not_found' } });

    // Walk the router's stack to find a matching layer
    const routerAny = router as any;
    const stack: any[] = routerAny.stack ?? [];

    // Parse params from path pattern
    function matchLayer(layer: any, url: string): Record<string, string> | null {
      if (!layer.route) return null;
      const routePath: string = layer.route.path;
      const routeMethod: string = Object.keys(layer.route.methods)[0]!.toUpperCase();
      if (routeMethod !== method) return null;

      const paramNames: string[] = [];
      const pattern = routePath.replace(/:([^/]+)/g, (_: string, name: string) => {
        paramNames.push(name);
        return '([^/]+)';
      });
      const re = new RegExp(`^${pattern}$`);
      const m = url.match(re);
      if (!m) return null;
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
      return params;
    }

    let matched = false;
    for (const layer of stack) {
      const params = matchLayer(layer, path);
      if (params !== null) {
        req.params = params as any;
        matched = true;
        const handler = layer.route.stack[0]?.handle;
        if (handler) {
          Promise.resolve(handler(req, res, next)).catch(next);
        } else {
          next();
        }
        break;
      }
    }
    if (!matched) next();
  });
}

// ── Mock factories ────────────────────────────────────────────────────────────

function makeToolPermRepo(rows: ToolPermissionRow[] = []): AdminPermissionRouteDeps['toolPermRepo'] {
  return {
    getForCompany: async () => ok(rows),
    upsert: async (companyId, toolId, role, enabled) =>
      ok({ companyId, toolId, role, enabled }),
  };
}

function makeActionPermRepo(rows: ToolActionPermissionRow[] = []): AdminPermissionRouteDeps['toolActionRepo'] {
  return {
    getForCompany: async () => ok(rows),
    upsert: async (companyId, toolId, role, actionGroup, enabled) =>
      ok({ companyId, toolId, role, actionGroup, enabled }),
  };
}

function makeDeptPermRepo(rows: DeptToolPermissionRow[] = []): AdminPermissionRouteDeps['deptToolPermRepo'] {
  return {
    getForDeptRole: async () => ok(rows),
    upsert: async (departmentId, roleId, toolId, actionGroup, allowed) =>
      ok({ departmentId, roleId, toolId, actionGroup, allowed }),
  };
}

function makePermService(): AdminPermissionRouteDeps['permissions'] {
  let companyClearCount = 0;
  let deptClearCount = 0;
  return {
    resolve: async () => { throw new Error('not needed'); },
    canInvoke: async () => { throw new Error('not needed'); },
    invalidateCompany: async () => { companyClearCount++; },
    invalidateDept: async () => { deptClearCount++; },
    _counts: { get company() { return companyClearCount; }, get dept() { return deptClearCount; } },
  } as any;
}

const noopAuditService: AdminPermissionRouteDeps['auditService'] = {
  record: () => {},
  query:  async () => [],
};

function makeDeps(overrides: Partial<AdminPermissionRouteDeps> = {}): AdminPermissionRouteDeps {
  const deps = {
    toolPermRepo: makeToolPermRepo(),
    toolActionRepo: makeActionPermRepo(),
    deptToolPermRepo: makeDeptPermRepo(),
    permissions: makePermService(),
    logger: noopLogger,
    auditService: noopAuditService,
    ...overrides,
  };
  return {
    ...deps,
    permissionWrites: overrides.permissionWrites ?? new PermissionWriteService({
      toolActionRepo: deps.toolActionRepo,
      deptToolPermRepo: deps.deptToolPermRepo,
      deptUserOverrideRepo: {
        getForUser: async () => ok([]),
        upsert: async () => ok({ departmentId: 'dept1', userId: 'user1', toolId: 'larkTask', actionGroup: 'read', allowed: true }),
      },
      permissions: deps.permissions,
      auditService: deps.auditService,
      toolRegistry: { byId: () => ({}) } as any,
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Admin permission routes', () => {
  describe('GET /companies/:companyId/matrix', () => {
    it('returns 200 with matrix shape', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status, body } = await callRoute(router, 'GET', '/companies/co1/matrix');
      assert.equal(status, 200);
      const b = body as any;
      assert.equal(b.companyId, 'co1');
      assert.ok(Array.isArray(b.matrix));
      assert.ok(b.matrix.length > 0);
    });

    it('each matrix entry has toolId and roles for MEMBER/COMPANY_ADMIN/SUPER_ADMIN', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { body } = await callRoute(router, 'GET', '/companies/co1/matrix');
      const entry = (body as any).matrix[0];
      assert.ok(entry.toolId);
      assert.ok(entry.roles.MEMBER);
      assert.ok(entry.roles.COMPANY_ADMIN);
      assert.ok(entry.roles.SUPER_ADMIN);
    });

    it('reflects DB override in matrix (tool disabled for MEMBER)', async () => {
      const toolPermRepo = makeToolPermRepo([
        { companyId: 'co1', toolId: 'larkTask', role: 'MEMBER', enabled: false },
      ]);
      const router = createAdminPermissionRoutes(makeDeps({ toolPermRepo }));
      const { body } = await callRoute(router, 'GET', '/companies/co1/matrix');
      const entry = (body as any).matrix.find((m: any) => m.toolId === 'larkTask');
      assert.equal(entry.roles.MEMBER.enabled, false);
      assert.equal(entry.roles.MEMBER.source, 'override');
    });

    it('returns 500 when toolPermRepo fails', async () => {
      const toolPermRepo = {
        getForCompany: async () => err(wrapInfra('prisma', 'getToolPermissions', new Error('db down'))),
        upsert: async () => { throw new Error(); },
      };
      const router = createAdminPermissionRoutes(makeDeps({ toolPermRepo }));
      const { status } = await callRoute(router, 'GET', '/companies/co1/matrix');
      assert.equal(status, 500);
    });
  });

  describe('PUT /companies/:companyId/tools/:toolId', () => {
    it('rejects fixed-policy memory recall tool toggles without persistence, cache invalidation, or audit', async () => {
      let writes = 0;
      const permissionService = makePermService();
      const audit: unknown[] = [];
      const router = createAdminPermissionRoutes(makeDeps({
        permissions: permissionService,
        auditService: { record: (entry: unknown) => audit.push(entry), query: async () => [] } as any,
        toolPermRepo: {
          getForCompany: async () => ok([]),
          upsert: async () => { writes++; return ok({ companyId: 'co1', toolId: 'memoryRecall', role: 'MEMBER', enabled: false }); },
        },
      }));
      const result = await callRoute(router, 'PUT', '/companies/co1/tools/memoryRecall', { role: 'MEMBER', enabled: false });
      assert.equal(result.status, 400);
      assert.equal(writes, 0);
      assert.equal((permissionService as any)._counts.company, 0);
      assert.equal(audit.length, 0);
    });

    it('returns 200 and invalidates company cache on success', async () => {
      const permSvc = makePermService();
      const router = createAdminPermissionRoutes(makeDeps({ permissions: permSvc }));
      const { status, body } = await callRoute(
        router, 'PUT', '/companies/co1/tools/larkTask',
        { role: 'MEMBER', enabled: false },
      );
      assert.equal(status, 200);
      assert.equal((body as any).ok, true);
      assert.equal((permSvc as any)._counts.company, 1);
    });

    it('returns 400 for unknown toolId', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router, 'PUT', '/companies/co1/tools/unknownTool',
        { role: 'MEMBER', enabled: false },
      );
      assert.equal(status, 400);
    });

    it('returns 400 when body is missing required fields', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router, 'PUT', '/companies/co1/tools/larkTask',
        { role: 'MEMBER' }, // missing enabled
      );
      assert.equal(status, 400);
    });

    it('returns 500 when repo upsert fails', async () => {
      const toolPermRepo = {
        getForCompany: async () => ok([]),
        upsert: async () => err(wrapInfra('prisma', 'upsertToolPermission', new Error('db down'))),
      };
      const router = createAdminPermissionRoutes(makeDeps({ toolPermRepo }));
      const { status } = await callRoute(
        router, 'PUT', '/companies/co1/tools/larkTask',
        { role: 'MEMBER', enabled: false },
      );
      assert.equal(status, 500);
    });
  });

  describe('PUT /companies/:companyId/tools/:toolId/actions/:actionGroup', () => {
    it('uses the shared writer to reject a canonical tool absent from the runtime registry', async () => {
      const permissionService = makePermService();
      const persisted: unknown[][] = [];
      const audits: unknown[] = [];
      const permissionWrites = new PermissionWriteService({
        toolActionRepo: {
          getForCompany: async () => ok([]),
          upsert: async (...args: unknown[]) => { persisted.push(args); return ok({ companyId: 'co1', toolId: 'larkTask', role: 'MEMBER', actionGroup: 'read', enabled: true }); },
        },
        deptToolPermRepo: makeDeptPermRepo(),
        deptUserOverrideRepo: { getForUser: async () => ok([]), upsert: async () => ok({ departmentId: 'd', userId: 'u', toolId: 'larkTask', actionGroup: 'read', allowed: true }) },
        permissions: permissionService,
        auditService: { record: (entry: unknown) => audits.push(entry) } as any,
        toolRegistry: { byId: (toolId: string) => ['larkTask', 'memoryRecall'].includes(toolId) ? {} : undefined } as any,
      });
      const router = createAdminPermissionRoutes(makeDeps({ permissionWrites, permissions: permissionService }));
      const missing = await callRoute(
        router, 'PUT', '/companies/co1/tools/larkCalendar/actions/read',
        { role: 'MEMBER', enabled: true },
      );
      assert.equal(missing.status, 400);
      assert.equal(persisted.length, 0);
      assert.equal((permissionService as any)._counts.company, 0);
      assert.equal(audits.length, 0);

      const validRouter = createAdminPermissionRoutes(makeDeps({ permissionWrites, permissions: permissionService }));
      const valid = await callRoute(
        validRouter, 'PUT', '/companies/co1/tools/larkTask/actions/read',
        { role: 'MEMBER', enabled: true },
      );
      assert.equal(valid.status, 200);
      assert.equal(persisted.length, 1);
      assert.equal((permissionService as any)._counts.company, 1);
      assert.equal(audits.length, 1);

      const memoryRecall = await callRoute(
        validRouter, 'PUT', '/companies/co1/tools/memoryRecall/actions/read',
        { role: 'MEMBER', enabled: true },
      );
      assert.equal(memoryRecall.status, 400);
      assert.equal(persisted.length, 1);
      assert.equal((permissionService as any)._counts.company, 1);
      assert.equal(audits.length, 1);
    });

    it('returns 200 and invalidates company cache', async () => {
      const permSvc = makePermService();
      const router = createAdminPermissionRoutes(makeDeps({ permissions: permSvc }));
      const { status, body } = await callRoute(
        router, 'PUT', '/companies/co1/tools/larkTask/actions/delete',
        { role: 'MEMBER', enabled: false },
      );
      assert.equal(status, 200);
      assert.equal((body as any).ok, true);
      assert.equal((permSvc as any)._counts.company, 1);
    });

    it('returns 400 for unsupported action on tool', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router, 'PUT', '/companies/co1/tools/larkMessaging/actions/delete',
        { role: 'MEMBER', enabled: false }, // larkMessaging only has read/send
      );
      assert.equal(status, 400);
    });

    it('returns 400 for unknown toolId', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router, 'PUT', '/companies/co1/tools/badTool/actions/read',
        { role: 'MEMBER', enabled: true },
      );
      assert.equal(status, 400);
    });
  });

  describe('GET /companies/:companyId/departments/:deptId/matrix', () => {
    it('returns 200 with dept permissions', async () => {
      const rows: DeptToolPermissionRow[] = [
        { departmentId: 'dept1', roleId: 'role1', toolId: 'larkTask', actionGroup: 'read', allowed: true },
      ];
      const router = createAdminPermissionRoutes(makeDeps({ deptToolPermRepo: makeDeptPermRepo(rows) }));
      const { status, body } = await callRoute(
        router, 'GET', '/companies/co1/departments/dept1/matrix', {}, { roleId: 'role1' },
      );
      assert.equal(status, 200);
      assert.equal((body as any).permissions.length, 1);
    });

    it('returns 400 when roleId query param is missing', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(router, 'GET', '/companies/co1/departments/dept1/matrix');
      assert.equal(status, 400);
    });
  });

  describe('PUT /companies/:companyId/departments/:deptId/tools/:toolId/actions/:actionGroup', () => {
    it('returns 200 and invalidates dept cache', async () => {
      const permSvc = makePermService();
      const router = createAdminPermissionRoutes(makeDeps({ permissions: permSvc }));
      const { status, body } = await callRoute(
        router, 'PUT', '/companies/co1/departments/dept1/tools/larkTask/actions/create',
        { roleId: 'role1', allowed: true, updatedBy: 'admin_user' },
      );
      assert.equal(status, 200);
      assert.equal((body as any).ok, true);
      assert.equal((permSvc as any)._counts.dept, 1);
    });

    it('returns 400 for unknown toolId', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router, 'PUT', '/companies/co1/departments/dept1/tools/badTool/actions/read',
        { roleId: 'role1', allowed: true, updatedBy: 'admin' },
      );
      assert.equal(status, 400);
    });

    it('returns 400 when body is missing updatedBy', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router, 'PUT', '/companies/co1/departments/dept1/tools/larkTask/actions/read',
        { roleId: 'role1', allowed: true }, // missing updatedBy
      );
      assert.equal(status, 400);
    });
  });

  describe('POST /companies/:companyId/cache/invalidate', () => {
    it('returns 200 and calls invalidateCompany', async () => {
      const permSvc = makePermService();
      const router = createAdminPermissionRoutes(makeDeps({ permissions: permSvc }));
      const { status, body } = await callRoute(router, 'POST', '/companies/co1/cache/invalidate');
      assert.equal(status, 200);
      assert.equal((body as any).scope, 'company');
      assert.equal((permSvc as any)._counts.company, 1);
    });
  });

  describe('POST /companies/:companyId/departments/:deptId/cache/invalidate', () => {
    it('returns 200 and calls invalidateDept', async () => {
      const permSvc = makePermService();
      const router = createAdminPermissionRoutes(makeDeps({ permissions: permSvc }));
      const { status, body } = await callRoute(
        router, 'POST', '/companies/co1/departments/dept1/cache/invalidate',
      );
      assert.equal(status, 200);
      assert.equal((body as any).scope, 'department');
      assert.equal((permSvc as any)._counts.dept, 1);
    });
  });
});
