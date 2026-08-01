import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminPermissionRoutes } from '../../src/http/admin/permission.routes.ts';
import type { AdminPermissionRouteDeps } from '../../src/http/admin/permission.routes.ts';
import { ok, err } from '../../src/shared/result.ts';
import { wrapInfra } from '../../src/shared/errors.ts';
import type { Logger } from '../../src/shared/logger.ts';
import type { Request, Response } from 'express';

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

async function callRoute(
  router: ReturnType<typeof createAdminPermissionRoutes>,
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body: unknown = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};

    const req = {
      method,
      path,
      params: {},
      query: {},
      body,
      headers: {},
    } as unknown as Request;

    const res = {
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = () => resolve({ status: 404, body: { error: 'not_found' } });
    const stack: any[] = (router as any).stack ?? [];

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
      const match = url.match(new RegExp(`^${pattern}$`));
      if (!match) return null;

      const params: Record<string, string> = {};
      paramNames.forEach((name, index) => { params[name] = match[index + 1]!; });
      return params;
    }

    for (const layer of stack) {
      const params = matchLayer(layer, path);
      if (params === null) continue;
      req.params = params as any;
      const handler = layer.route.stack[0]?.handle;
      if (handler) {
        Promise.resolve(handler(req, res, next)).catch(next);
      } else {
        next();
      }
      return;
    }
    next();
  });
}

function makeToolPermRepo(): AdminPermissionRouteDeps['toolPermRepo'] {
  return {
    getForCompany: async () => ok([]),
    upsert: async (companyId, toolId, role, enabled) =>
      ok({ companyId, toolId, role, enabled }),
  };
}

function makePermService(): AdminPermissionRouteDeps['permissions'] {
  let companyClearCount = 0;
  return {
    resolve: async () => { throw new Error('not needed'); },
    canInvoke: async () => { throw new Error('not needed'); },
    invalidateCompany: async () => { companyClearCount++; },
    invalidateDept: async () => {},
    _counts: { get company() { return companyClearCount; } },
  } as any;
}

const noopAuditService: AdminPermissionRouteDeps['auditService'] = {
  record: () => {},
  query:  async () => [],
};

function makeDeps(overrides: Partial<AdminPermissionRouteDeps> = {}): AdminPermissionRouteDeps {
  return {
    toolPermRepo: makeToolPermRepo(),
    permissions: makePermService(),
    logger: noopLogger,
    auditService: noopAuditService,
    ...overrides,
  };
}

describe('Admin permission routes', () => {
  describe('PUT /companies/:companyId/tools/:toolId', () => {
    it('updates the central knowledge RBAC switch with invalidation and audit', async () => {
      let writes = 0;
      const permissionService = makePermService();
      const audit: unknown[] = [];
      const router = createAdminPermissionRoutes(makeDeps({
        permissions: permissionService,
        auditService: { record: (entry: unknown) => audit.push(entry), query: async () => [] } as any,
        toolPermRepo: {
          getForCompany: async () => ok([]),
          upsert: async () => { writes++; return ok({ companyId: 'co1', toolId: 'knowledge', role: 'MEMBER', enabled: false }); },
        },
      }));

      const result = await callRoute(
        router,
        'PUT',
        '/companies/co1/tools/knowledge',
        { role: 'MEMBER', enabled: false },
      );

      assert.equal(result.status, 200);
      assert.equal(writes, 1);
      assert.equal((permissionService as any)._counts.company, 1);
      assert.equal(audit.length, 1);
    });

    it('returns 200 and invalidates company cache on success', async () => {
      const permissionService = makePermService();
      const router = createAdminPermissionRoutes(makeDeps({ permissions: permissionService }));
      const { status, body } = await callRoute(
        router,
        'PUT',
        '/companies/co1/tools/larkTask',
        { role: 'MEMBER', enabled: false },
      );

      assert.equal(status, 200);
      assert.equal((body as any).ok, true);
      assert.equal((permissionService as any)._counts.company, 1);
    });

    it('returns 400 for an unknown tool', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router,
        'PUT',
        '/companies/co1/tools/unknownTool',
        { role: 'MEMBER', enabled: false },
      );
      assert.equal(status, 400);
    });

    it('returns 400 when enabled is missing', async () => {
      const router = createAdminPermissionRoutes(makeDeps());
      const { status } = await callRoute(
        router,
        'PUT',
        '/companies/co1/tools/larkTask',
        { role: 'MEMBER' },
      );
      assert.equal(status, 400);
    });

    it('returns 500 when persistence fails', async () => {
      const router = createAdminPermissionRoutes(makeDeps({
        toolPermRepo: {
          getForCompany: async () => ok([]),
          upsert: async () => err(wrapInfra('prisma', 'upsertToolPermission', new Error('db down'))),
        },
      }));
      const { status } = await callRoute(
        router,
        'PUT',
        '/companies/co1/tools/larkTask',
        { role: 'MEMBER', enabled: false },
      );
      assert.equal(status, 500);
    });
  });

  it('does not expose the removed legacy permission routes', async () => {
    const router = createAdminPermissionRoutes(makeDeps());
    const removedRoutes: Array<['GET' | 'PUT' | 'POST', string]> = [
      ['GET', '/companies/co1/matrix'],
      ['PUT', '/companies/co1/tools/larkTask/actions/read'],
      ['GET', '/companies/co1/departments/dept1/matrix'],
      ['PUT', '/companies/co1/departments/dept1/tools/larkTask/actions/read'],
      ['POST', '/companies/co1/cache/invalidate'],
      ['POST', '/companies/co1/departments/dept1/cache/invalidate'],
    ];

    for (const [method, path] of removedRoutes) {
      const { status } = await callRoute(router, method, path);
      assert.equal(status, 404, `${method} ${path} must stay removed`);
    }
  });
});
