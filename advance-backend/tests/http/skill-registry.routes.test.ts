/**
 * Unit tests for skill-registry.routes.ts — the Skills Lab admin API.
 *
 * Exercises the HTTP contract (status mapping, company scoping, validation)
 * against a mocked service, without a real server or database.
 *
 *   GET    /tree
 *   POST   /folders
 *   PUT    /folders/:folderId
 *   POST   /folders/:folderId/move
 *   POST   /folders/:folderId/archive
 *   POST   /skills/:skillId/move
 *   POST   /backfill
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createSkillRegistryRoutes } from '../../src/http/admin/skill-registry.routes.ts';
import type { SkillRegistryAdminService } from '../../src/application/skills/skill-registry-admin.service.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this as typeof noopLogger; },
} as any;

const DEFAULT_LOCALS = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };
const SUPER_ADMIN_LOCALS = { companyId: '', isSuperAdmin: true, userId: 'u-sa' };

const UUID = '11111111-1111-1111-1111-111111111111';

async function callRoute(
  router: ReturnType<typeof createSkillRegistryRoutes>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string>; body?: Record<string, unknown>; locals?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};
    const locals = opts.locals ?? { ...DEFAULT_LOCALS };

    const req = { method, path, params: {}, query: opts.query ?? {}, body: opts.body ?? {}, headers: {} } as unknown as Request;
    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;
    const next = (err?: unknown) => {
      if (err) { const e = err as Error & { status?: number }; status = e.status ?? 500; responseBody = { success: false, message: e.message }; }
      resolve({ status, body: responseBody });
    };

    const stack: any[] = (router as any).stack ?? [];
    const matchLayer = (layer: any, url: string): Record<string, string> | null => {
      if (!layer.route) return null;
      const routePath: string = layer.route.path;
      const routeMethod: string = Object.keys(layer.route.methods)[0]!.toUpperCase();
      if (routeMethod !== method) return null;
      const paramNames: string[] = [];
      const pattern = routePath.replace(/:([^/]+)/g, (_: string, name: string) => { paramNames.push(name); return '([^/]+)'; });
      const m = url.match(new RegExp(`^${pattern}$`));
      if (!m) return null;
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
      return params;
    };

    let matched = false;
    for (const layer of stack) {
      const params = matchLayer(layer, path);
      if (params !== null) {
        req.params = params as any;
        matched = true;
        const handler = layer.route.stack[0]?.handle;
        if (handler) { Promise.resolve(handler(req, res, next)).catch(next); } else { next(); }
        break;
      }
    }
    if (!matched) next();
  });
}

function makeService(overrides: Partial<SkillRegistryAdminService> = {}): SkillRegistryAdminService {
  return {
    getTree: async () => ({ ok: true, value: { registryRevision: 1, companyWide: { folders: [], skills: [] }, departments: [] } }),
    createFolder: async () => ({ ok: true, value: { id: 'f-1', name: 'F', slug: 'f', departmentId: null, parentId: null, status: 'active' } }),
    renameFolder: async () => ({ ok: true, value: { id: 'f-1', name: 'F2', slug: 'f2', departmentId: null, parentId: null, status: 'active' } }),
    moveFolder: async () => ({ ok: true, value: { id: 'f-1', name: 'F', slug: 'f', departmentId: null, parentId: null, status: 'active' } }),
    archiveFolder: async () => ({ ok: true, value: { archivedFolders: 1, detachedSkills: 2 } }),
    moveSkill: async () => ({ ok: true, value: { skillId: 'sk-1', folderId: 'f-1' } }),
    backfillFolders: async () => ({ ok: true, value: { foldersCreated: 3, skillsPlaced: 8 } }),
    getSkillDetail: async () => ({ ok: true, value: { id: 'sk-1', name: 'S', slug: 's', aliases: ['a'], folderPath: ['General'], toolIds: [] } }),
    getSkillAccess: async () => ({ ok: true, value: { skillId: 'sk-1', scope: 'department', departmentId: 'd1', grants: [{ granteeType: 'role', granteeId: 'r1', label: 'Manager', detail: 'Finance', grantedBy: 'admin', createdAt: '2026-07-14T00:00:00.000Z' }], candidates: { users: [{ granteeId: 'u1', label: 'Aarav', detail: 'aarav@acme.com' }], departments: [{ granteeId: 'd1', label: 'Finance', detail: 'Department' }], roles: [{ granteeId: 'r2', label: 'Member', detail: 'Finance' }], company: { granteeId: 'co-1', label: 'Acme', detail: 'Everyone in the company' } } } }),
    grantSkillAccess: async () => ({ ok: true, value: { granteeType: 'department', granteeId: 'd1', label: 'Finance', detail: 'Department', grantedBy: 'admin', createdAt: '2026-07-14T00:00:00.000Z' } }),
    revokeSkillAccess: async () => ({ ok: true, value: { skillId: 'sk-1', granteeType: 'role', granteeId: 'r1' } }),
    getSkillAudit: async () => ({ ok: true, value: [{ id: 'a1', action: 'gateway.skill.get', actorId: 'u1', outcome: 'success', metadata: { skillId: 'sk-1' }, createdAt: '2026-07-14T10:00:00.000Z' }] }),
    ...overrides,
  } as unknown as SkillRegistryAdminService;
}

const routes = (svc: SkillRegistryAdminService) =>
  createSkillRegistryRoutes({ skillRegistryService: svc, logger: noopLogger });

describe('skill-registry routes', () => {
  it('GET /tree returns the tree', async () => {
    const r = await callRoute(routes(makeService()), 'GET', '/tree');
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.data.registryRevision, 1);
  });

  it('POST /folders creates a folder (201)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', '/folders', { body: { name: 'Ops Core' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.id, 'f-1');
  });

  it('POST /folders rejects an empty name (400)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', '/folders', { body: { name: '' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.success, false);
  });

  it('maps a conflict service error to 409', async () => {
    const svc = makeService({ createFolder: async () => ({ ok: false, error: { kind: 'conflict', message: 'dup' } }) as any });
    const r = await callRoute(routes(svc), 'POST', '/folders', { body: { name: 'Dup' } });
    assert.equal(r.status, 409);
  });

  it('maps a validation service error to 400', async () => {
    const svc = makeService({ moveFolder: async () => ({ ok: false, error: { kind: 'validation', message: 'cycle' } }) as any });
    const r = await callRoute(routes(svc), 'POST', `/folders/${UUID}/move`, { body: { parentId: UUID } });
    assert.equal(r.status, 400);
  });

  it('PUT /folders/:id renames', async () => {
    const r = await callRoute(routes(makeService()), 'PUT', `/folders/${UUID}`, { body: { name: 'Renamed' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.slug, 'f2');
  });

  it('POST /folders/:id/archive returns cascade counts', async () => {
    const r = await callRoute(routes(makeService()), 'POST', `/folders/${UUID}/archive`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.detachedSkills, 2);
  });

  it('GET /skills/:id returns skill detail', async () => {
    const r = await callRoute(routes(makeService()), 'GET', `/skills/${UUID}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.aliases, ['a']);
    assert.deepEqual(r.body.data.folderPath, ['General']);
  });

  it('GET /skills/:id maps a not_found service error to 404', async () => {
    const svc = makeService({ getSkillDetail: async () => ({ ok: false, error: { kind: 'not_found', message: 'gone' } }) as any });
    const r = await callRoute(routes(svc), 'GET', `/skills/${UUID}`);
    assert.equal(r.status, 404);
  });

  it('GET /skills/:id/access returns grants + bucketed candidates', async () => {
    const r = await callRoute(routes(makeService()), 'GET', `/skills/${UUID}/access`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.grants.map((g: any) => g.granteeId), ['r1']);
    assert.deepEqual(r.body.data.candidates.roles.map((c: any) => c.granteeId), ['r2']);
    assert.equal(r.body.data.candidates.company.granteeId, 'co-1');
  });

  it('POST /skills/:id/access grants a grantee (201)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', `/skills/${UUID}/access`, { body: { granteeType: 'department', granteeId: UUID } });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.granteeType, 'department');
  });

  it('POST /skills/:id/access rejects a missing grantee (400)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', `/skills/${UUID}/access`, { body: { granteeType: 'department' } });
    assert.equal(r.status, 400);
  });

  it('POST /skills/:id/access rejects a bad granteeType (400)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', `/skills/${UUID}/access`, { body: { granteeType: 'nonsense', granteeId: UUID } });
    assert.equal(r.status, 400);
  });

  it('POST /skills/:id/access maps a validation error to 400', async () => {
    const svc = makeService({ grantSkillAccess: async () => ({ ok: false, error: { kind: 'validation', message: 'cross-dept' } }) as any });
    const r = await callRoute(routes(svc), 'POST', `/skills/${UUID}/access`, { body: { granteeType: 'department', granteeId: UUID } });
    assert.equal(r.status, 400);
  });

  it('DELETE /skills/:id/access/:granteeType/:granteeId revokes', async () => {
    const r = await callRoute(routes(makeService()), 'DELETE', `/skills/${UUID}/access/role/${UUID}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.granteeType, 'role');
  });

  it('DELETE with a bad granteeType is rejected (400)', async () => {
    const r = await callRoute(routes(makeService()), 'DELETE', `/skills/${UUID}/access/nonsense/${UUID}`);
    assert.equal(r.status, 400);
  });

  it('GET /skills/:id/audit returns audit entries', async () => {
    const r = await callRoute(routes(makeService()), 'GET', `/skills/${UUID}/audit`, { query: { limit: '10' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data[0].action, 'gateway.skill.get');
  });

  it('POST /skills/:id/move accepts folderId null (detach to root)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', `/skills/${UUID}/move`, { body: { folderId: null } });
    assert.equal(r.status, 200);
  });

  it('POST /skills/:id/move rejects a missing folderId field (400)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', `/skills/${UUID}/move`, { body: {} });
    assert.equal(r.status, 400);
  });

  it('POST /backfill returns counts', async () => {
    const r = await callRoute(routes(makeService()), 'POST', '/backfill', { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.foldersCreated, 3);
  });

  it('super-admin without companyId on /tree is rejected (400)', async () => {
    const r = await callRoute(routes(makeService()), 'GET', '/tree', { locals: { ...SUPER_ADMIN_LOCALS } });
    assert.equal(r.status, 400);
  });

  it('company admin passing a foreign companyId is denied (403)', async () => {
    const r = await callRoute(routes(makeService()), 'POST', '/backfill', {
      body: { companyId: '99999999-9999-9999-9999-999999999999' },
    });
    assert.equal(r.status, 403);
  });
});
