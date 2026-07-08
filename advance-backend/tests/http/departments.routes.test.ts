/**
 * Unit tests for departments.routes.ts.
 *
 * Tests all 17 department routes without spinning up a real server.
 *
 * Routes covered:
 *   GET    /                                               — list departments
 *   GET    /:id                                            — department detail
 *   GET    /:id/candidates                                 — member candidate search
 *   POST   /                                               — create department
 *   PUT    /:id                                            — update department
 *   POST   /:id/archive                                    — archive department
 *   PUT    /:id/config                                     — update agent config
 *   POST   /:id/roles                                      — create role
 *   PUT    /:id/roles/:roleId                              — update role
 *   DELETE /:id/roles/:roleId                              — delete role
 *   PUT    /:id/memberships                                — upsert membership
 *   DELETE /:id/memberships/:userId                        — remove membership
 *   POST   /:id/skills                                     — create skill
 *   PUT    /:id/skills/:skillId                            — update skill
 *   POST   /:id/skills/:skillId/archive                    — archive skill
 *   PUT    /:id/role-permissions/:roleId/:toolId/:ag       — update role permission
 *   PUT    /:id/user-overrides/:userId/:toolId/:ag         — update user override
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createDepartmentRoutes } from '../../src/http/admin/departments.routes.ts';
import type { DepartmentAdminService } from '../../src/application/departments/department-admin.service.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const DEFAULT_LOCALS     = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };
const SUPER_ADMIN_LOCALS = { companyId: '', isSuperAdmin: true, userId: 'u-sa' };

async function callRoute(
  router: ReturnType<typeof createDepartmentRoutes>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: {
    query?:  Record<string, string>;
    body?:   Record<string, unknown>;
    locals?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};
    const locals = opts.locals ?? { ...DEFAULT_LOCALS };

    const req = {
      method, path,
      params:  {},
      query:   opts.query ?? {},
      body:    opts.body  ?? {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => { responseBody = b; resolve({ status, body: responseBody }); return res; },
    } as unknown as Response;

    const next = (err?: unknown) => {
      if (err) {
        const e = err as Error & { status?: number };
        status = e.status ?? 500;
        responseBody = { success: false, message: e.message };
      }
      resolve({ status, body: responseBody });
    };

    const stack: any[] = (router as any).stack ?? [];

    function matchLayer(layer: any, url: string): Record<string, string> | null {
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
    }

    let matched = false;
    for (const layer of stack) {
      const params = matchLayer(layer, path);
      if (params !== null) {
        req.params = params as any;
        matched = true;
        const handler = layer.route.stack[0]?.handle;
        if (handler) { Promise.resolve(handler(req, res, next)).catch(next); }
        else { next(); }
        break;
      }
    }
    if (!matched) next();
  });
}

// ─── Fake data ────────────────────────────────────────────────────────────────

const fakeDept = {
  id: 'dept-1', name: 'Sales', status: 'active', createdAt: '2025-01-01T00:00:00.000Z',
};

const fakeDeptDetail = {
  ...fakeDept,
  description: 'Sales team',
  roles:       [],
  members:     [],
  config:      null,
  skills:      [],
  availableTools: [],
};

const fakeRole = { id: 'role-1', name: 'Lead', slug: 'LEAD', zohoReadScope: 'personalized' };
const fakeSkill = { id: 'skill-1', name: 'Negotiation', status: 'active' };
const fakePerm  = { id: 'perm-1', toolId: 'zoho-crm', roleId: 'role-1', actionGroup: 'leads.read', allowed: true };

function makeService(overrides: Partial<DepartmentAdminService> = {}): DepartmentAdminService {
  return {
    listDepartments:     async () => ({ ok: true, value: [fakeDept] }),
    getDepartmentDetail: async () => ({ ok: true, value: fakeDeptDetail }),
    searchCandidates:    async () => ({ ok: true, value: [] }),
    createDepartment:    async () => ({ ok: true, value: fakeDept }),
    updateDepartment:    async () => ({ ok: true, value: fakeDept }),
    archiveDepartment:   async () => ({ ok: true, value: { id: 'dept-1', status: 'archived' } }),
    updateConfig:        async () => ({ ok: true, value: { departmentId: 'dept-1', systemPrompt: '', skillsMarkdown: '', isActive: true, updatedAt: '2025-01-01T00:00:00.000Z' } }),
    createRole:          async () => ({ ok: true, value: fakeRole }),
    updateRole:          async () => ({ ok: true, value: fakeRole }),
    deleteRole:          async () => ({ ok: true, value: { deleted: true } }),
    upsertMembership:    async () => ({ ok: true, value: { id: 'mem-1' } }),
    removeMembership:    async () => ({ ok: true, value: { deleted: true } }),
    createSkill:         async () => ({ ok: true, value: fakeSkill }),
    updateSkill:         async () => ({ ok: true, value: fakeSkill }),
    archiveSkill:        async () => ({ ok: true, value: { id: 'skill-1', status: 'archived' } }),
    updateRolePermission: async () => ({ ok: true, value: fakePerm }),
    updateUserOverride:   async () => ({ ok: true, value: { id: 'ov-1', allowed: true } }),
    backfillEmptyRolePermissions: async () => ({
      ok: true,
      value: { departmentsTouched: 0, rolesSeeded: 0, rowsCreated: 0 },
    }),
    getBookModulePermissions: async () => ({ ok: true, value: [] }),
    updateBookModulePermission: async () => ({ ok: true, value: { roleId: 'role-1', module: 'invoices', enabled: true } }),
    ...overrides,
  } as unknown as DepartmentAdminService;
}

function makeRouter(overrides?: Partial<DepartmentAdminService>) {
  return createDepartmentRoutes({ deptAdminService: makeService(overrides), logger: noopLogger });
}

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET / (departments)', () => {
  it('returns 200 with dept list', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].id, 'dept-1');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });

  it('returns 500 when service fails', async () => {
    const { status } = await callRoute(
      makeRouter({ listDepartments: async () => ({ ok: false, error: { kind: 'internal', message: 'db' } }) }),
      'GET', '/',
    );
    assert.equal(status, 500);
  });
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

describe('GET /:id (departments)', () => {
  it('returns 200 with dept detail', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/dept-1');
    assert.equal(status, 200);
    assert.equal((body as any).data.id, 'dept-1');
  });

  it('returns 404 when not found', async () => {
    const { status } = await callRoute(
      makeRouter({ getDepartmentDetail: async () => ({ ok: false, error: { kind: 'not_found', message: 'missing' } }) }),
      'GET', '/dept-missing',
    );
    assert.equal(status, 404);
  });

  it('passes correct id to service', async () => {
    let capturedId: string | undefined;
    const router = createDepartmentRoutes({
      deptAdminService: makeService({ getDepartmentDetail: async (id) => { capturedId = id; return { ok: true, value: fakeDeptDetail }; } }),
      logger: noopLogger,
    });
    await callRoute(router, 'GET', '/dept-xyz');
    assert.equal(capturedId, 'dept-xyz');
  });
});

// ─── GET /:id/candidates ──────────────────────────────────────────────────────

describe('GET /:id/candidates', () => {
  it('returns 200 with empty candidate list', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/dept-1/candidates', {
      query: { query: 'alice' },
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray((body as any).data));
  });

  it('returns 400 when query param is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/dept-1/candidates');
    assert.equal(status, 400);
  });
});

// ─── POST / (create dept) ─────────────────────────────────────────────────────

describe('POST / (create department)', () => {
  const validBody = { name: 'Engineering' };

  it('returns 201 on success', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/', { body: validBody });
    assert.equal(status, 201);
    assert.equal((body as any).success, true);
  });

  it('returns 400 when name is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/', {
      body: { description: 'no name' },
    });
    assert.equal(status, 400);
  });

  it('returns 409 on conflict', async () => {
    const { status } = await callRoute(
      makeRouter({ createDepartment: async () => ({ ok: false, error: { kind: 'conflict', message: 'exists' } }) }),
      'POST', '/',
      { body: validBody },
    );
    assert.equal(status, 409);
  });
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

describe('PUT /:id (update department)', () => {
  it('returns 200 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1', {
      body: { name: 'New Name' },
    });
    assert.equal(status, 200);
  });

  it('returns 404 when not found', async () => {
    const { status } = await callRoute(
      makeRouter({ updateDepartment: async () => ({ ok: false, error: { kind: 'not_found', message: 'missing' } }) }),
      'PUT', '/dept-missing',
      { body: { name: 'X' } },
    );
    assert.equal(status, 404);
  });
});

// ─── POST /:id/archive ────────────────────────────────────────────────────────

describe('POST /:id/archive', () => {
  it('returns 200 with archived status', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/dept-1/archive');
    assert.equal(status, 200);
    assert.equal((body as any).data.status, 'archived');
  });

  it('returns 404 when not found', async () => {
    const { status } = await callRoute(
      makeRouter({ archiveDepartment: async () => ({ ok: false, error: { kind: 'not_found', message: 'missing' } }) }),
      'POST', '/dept-missing/archive',
    );
    assert.equal(status, 404);
  });
});

// ─── PUT /:id/config ──────────────────────────────────────────────────────────

describe('PUT /:id/config', () => {
  const validConfig = { systemPrompt: 'You are helpful.', skillsMarkdown: '# Skills' };

  it('returns 200 on success', async () => {
    const { status, body } = await callRoute(makeRouter(), 'PUT', '/dept-1/config', {
      body: validConfig,
    });
    assert.equal(status, 200);
    assert.equal((body as any).data.departmentId, 'dept-1');
  });

  it('returns 400 when systemPrompt is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/config', {
      body: { skillsMarkdown: '# Skills' },
    });
    assert.equal(status, 400);
  });
});

// ─── POST /:id/roles ──────────────────────────────────────────────────────────

describe('POST /:id/roles', () => {
  const validRole = { name: 'Senior Lead', slug: 'SENIOR_LEAD' };

  it('returns 201 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/dept-1/roles', { body: validRole });
    assert.equal(status, 201);
  });

  it('returns 400 when name is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/dept-1/roles', {
      body: { slug: 'LEAD' },
    });
    assert.equal(status, 400);
  });

  it('returns 409 on slug conflict', async () => {
    const { status } = await callRoute(
      makeRouter({ createRole: async () => ({ ok: false, error: { kind: 'conflict', message: 'slug exists' } }) }),
      'POST', '/dept-1/roles',
      { body: validRole },
    );
    assert.equal(status, 409);
  });
});

// ─── PUT /:id/roles/:roleId ───────────────────────────────────────────────────

describe('PUT /:id/roles/:roleId', () => {
  it('returns 200 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/roles/role-1', {
      body: { name: 'Updated Lead' },
    });
    assert.equal(status, 200);
  });

  it('returns 400 when name is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/roles/role-1', {
      body: {},
    });
    assert.equal(status, 400);
  });

  it('passes correct ids to service', async () => {
    let capturedId: string | undefined;
    let capturedRoleId: string | undefined;
    const router = createDepartmentRoutes({
      deptAdminService: makeService({
        updateRole: async (id, _cid, roleId) => {
          capturedId     = id;
          capturedRoleId = roleId;
          return { ok: true, value: fakeRole };
        },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'PUT', '/dept-abc/roles/role-xyz', { body: { name: 'X' } });
    assert.equal(capturedId, 'dept-abc');
    assert.equal(capturedRoleId, 'role-xyz');
  });
});

// ─── DELETE /:id/roles/:roleId ────────────────────────────────────────────────

describe('DELETE /:id/roles/:roleId', () => {
  it('returns 200 with deleted:true', async () => {
    const { status, body } = await callRoute(makeRouter(), 'DELETE', '/dept-1/roles/role-1');
    assert.equal(status, 200);
    assert.equal((body as any).data.deleted, true);
  });

  it('returns 403 when role is system', async () => {
    const { status } = await callRoute(
      makeRouter({ deleteRole: async () => ({ ok: false, error: { kind: 'forbidden', message: 'system role' } }) }),
      'DELETE', '/dept-1/roles/MANAGER',
    );
    assert.equal(status, 403);
  });
});

// ─── PUT /:id/memberships ─────────────────────────────────────────────────────

describe('PUT /:id/memberships', () => {
  it('returns 200 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/memberships', {
      body: { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002' },
    });
    assert.equal(status, 200);
  });

  it('returns 404 when user not found', async () => {
    const { status } = await callRoute(
      makeRouter({ upsertMembership: async () => ({ ok: false, error: { kind: 'not_found', message: 'user gone' } }) }),
      'PUT', '/dept-1/memberships',
      { body: { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000099' } },
    );
    assert.equal(status, 404);
  });
});

// ─── DELETE /:id/memberships/:userId ─────────────────────────────────────────

describe('DELETE /:id/memberships/:userId', () => {
  it('returns 200 with deleted:true', async () => {
    const { status, body } = await callRoute(makeRouter(), 'DELETE', '/dept-1/memberships/u-2');
    assert.equal(status, 200);
    assert.equal((body as any).data.deleted, true);
  });

  it('passes correct userId to service', async () => {
    let capturedUserId: string | undefined;
    const router = createDepartmentRoutes({
      deptAdminService: makeService({
        removeMembership: async (_id, _cid, userId) => { capturedUserId = userId; return { ok: true, value: { deleted: true } }; },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'DELETE', '/dept-1/memberships/u-target');
    assert.equal(capturedUserId, 'u-target');
  });
});

// ─── POST /:id/skills ─────────────────────────────────────────────────────────

describe('POST /:id/skills', () => {
  const validSkill = { name: 'Negotiation', markdown: '## Negotiation\nBe persuasive.' };

  it('returns 201 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/dept-1/skills', { body: validSkill });
    assert.equal(status, 201);
  });

  it('returns 400 when name is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/dept-1/skills', {
      body: { markdown: '## Skill' },
    });
    assert.equal(status, 400);
  });

  it('returns 400 when markdown is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/dept-1/skills', {
      body: { name: 'Skill' },
    });
    assert.equal(status, 400);
  });
});

// ─── PUT /:id/skills/:skillId ─────────────────────────────────────────────────

describe('PUT /:id/skills/:skillId', () => {
  it('returns 200 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/skills/skill-1', {
      body: { name: 'Updated Skill' },
    });
    assert.equal(status, 200);
  });

  it('returns 404 when skill not found', async () => {
    const { status } = await callRoute(
      makeRouter({ updateSkill: async () => ({ ok: false, error: { kind: 'not_found', message: 'missing' } }) }),
      'PUT', '/dept-1/skills/skill-missing',
      { body: { name: 'X' } },
    );
    assert.equal(status, 404);
  });
});

// ─── POST /:id/skills/:skillId/archive ────────────────────────────────────────

describe('POST /:id/skills/:skillId/archive', () => {
  it('returns 200 with archived status', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/dept-1/skills/skill-1/archive');
    assert.equal(status, 200);
    assert.equal((body as any).data.status, 'archived');
  });

  it('returns 404 when skill not found', async () => {
    const { status } = await callRoute(
      makeRouter({ archiveSkill: async () => ({ ok: false, error: { kind: 'not_found', message: 'missing' } }) }),
      'POST', '/dept-1/skills/skill-missing/archive',
    );
    assert.equal(status, 404);
  });
});

// ─── POST /backfill-permissions ───────────────────────────────────────────────

describe('POST /backfill-permissions', () => {
  it('returns 200 on success', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/backfill-permissions', {
      body: {},
    });
    assert.equal(status, 200);
    assert.equal((body as any).success, true);
  });

  it('passes optional departmentId to service', async () => {
    let capturedDeptId: string | undefined;
    const router = createDepartmentRoutes({
      deptAdminService: makeService({
        backfillEmptyRolePermissions: async (_companyId, _updatedBy, departmentId) => {
          capturedDeptId = departmentId;
          return { ok: true, value: { departmentsTouched: 1, rolesSeeded: 2, rowsCreated: 10 } };
        },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'POST', '/backfill-permissions', {
      body: { departmentId: 'dept-finance' },
    });
    assert.equal(capturedDeptId, 'dept-finance');
  });
});

// ─── PUT /:id/role-permissions/:roleId/:toolId/:ag ────────────────────────────

describe('PUT /:id/role-permissions/:roleId/:toolId/:actionGroup', () => {
  it('returns 200 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/role-permissions/role-1/zoho-crm/leads.read', {
      body: { allowed: true },
    });
    assert.equal(status, 200);
  });

  it('returns 400 when allowed is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/role-permissions/role-1/zoho-crm/leads.read', {
      body: {},
    });
    assert.equal(status, 400);
  });

  it('passes correct params to service', async () => {
    let captured: any;
    const router = createDepartmentRoutes({
      deptAdminService: makeService({
        updateRolePermission: async (id, _cid, roleId, toolId, ag, allowed) => {
          captured = { id, roleId, toolId, ag, allowed };
          return { ok: true, value: fakePerm };
        },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'PUT', '/dept-abc/role-permissions/role-xyz/zoho-crm/leads.write', {
      body: { allowed: false },
    });
    assert.equal(captured.id, 'dept-abc');
    assert.equal(captured.roleId, 'role-xyz');
    assert.equal(captured.toolId, 'zoho-crm');
    assert.equal(captured.ag, 'leads.write');
    assert.equal(captured.allowed, false);
  });
});

// ─── PUT /:id/user-overrides/:userId/:toolId/:ag ──────────────────────────────

describe('PUT /:id/user-overrides/:userId/:toolId/:actionGroup', () => {
  it('returns 200 on success', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/user-overrides/u-2/zoho-crm/leads.read', {
      body: { allowed: true },
    });
    assert.equal(status, 200);
  });

  it('returns 400 when allowed is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'PUT', '/dept-1/user-overrides/u-2/zoho-crm/leads.read', {
      body: {},
    });
    assert.equal(status, 400);
  });

  it('passes correct userId to service', async () => {
    let capturedUserId: string | undefined;
    const router = createDepartmentRoutes({
      deptAdminService: makeService({
        updateUserOverride: async (_id, _cid, userId) => {
          capturedUserId = userId;
          return { ok: true, value: { id: 'ov-1', allowed: true } };
        },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'PUT', '/dept-1/user-overrides/u-target/zoho-crm/leads.read', {
      body: { allowed: true },
    });
    assert.equal(capturedUserId, 'u-target');
  });
});
