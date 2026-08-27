/**
 * Department admin routes.
 *
 * All routes require admin auth. Mounted at /api/admin/departments.
 *
 *   GET    /                                      — list departments
 *   GET    /:id                                   — department detail
 *   GET    /:id/candidates                        — member candidate search
 *   POST   /                                      — create department
 *   PUT    /:id                                   — update department
 *   POST   /:id/archive                           — archive department
 *   PUT    /:id/config                            — update agent config
 *   POST   /:id/roles                             — create role
 *   PUT    /:id/roles/:roleId                     — update role
 *   DELETE /:id/roles/:roleId                     — delete role
 *   PUT    /:id/memberships                       — upsert membership
 *   DELETE /:id/memberships/:userId               — remove membership
 *   POST   /:id/skills                            — rejected legacy direct write
 *   PUT    /:id/skills/:skillId                   — rejected legacy direct write
 *   POST   /:id/skills/:skillId/archive           — rejected legacy direct write
 *   PUT    /:id/role-permissions/:roleId/:toolId/:actionGroup — update role permission
 *   PUT    /:id/user-overrides/:userId/:toolId/:actionGroup   — update user override
 *   POST   /backfill-permissions                              — seed empty role matrices
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { DepartmentAdminService } from '../../application/departments/department-admin.service';
import type { AuditService } from '../../application/observability/audit.service';
import type { Logger } from '../../shared/logger';

export interface DepartmentRoutesDeps {
  deptAdminService: DepartmentAdminService;
  auditService?:       Pick<AuditService, 'record'>;
  logger:           Logger;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

type RouteError = Error & { status: number };
const routeError = (status: number, message: string): RouteError => {
  const e = new Error(message) as RouteError;
  e.status = status;
  return e;
};

const success = <T>(res: Response, data: T, message?: string, status = 200) =>
  res.status(status).json({ success: true, data, ...(message ? { message } : {}) });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) { fail(res, 400, error.issues[0]?.message ?? 'Invalid request'); return; }
      if (error instanceof Error && 'status' in error && typeof (error as RouteError).status === 'number') {
        fail(res, (error as RouteError).status, error.message); return;
      }
      throw error;
    }
  };

function resolveCompanyId(res: Response, providedId?: string): string {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  const localId      = (res.locals['companyId'] as string | undefined) ?? '';
  if (isSuperAdmin) {
    if (!providedId) throw routeError(400, 'companyId is required for super-admin requests');
    return providedId;
  }
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId;
}

function resolveServiceError(res: Response, error: { kind: string; message: string }): void {
  const statusMap: Record<string, number> = {
    not_found:  404,
    conflict:   409,
    validation: 400,
    forbidden:  403,
    internal:   500,
  };
  fail(res, statusMap[error.kind] ?? 500, error.message);
}

function resolveUserId(res: Response): string {
  return (res.locals['userId'] as string | undefined) ?? 'unknown';
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const createDeptSchema = z.object({
  companyId:   z.string().uuid().optional(),
  name:        z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
});

const updateDeptSchema = z.object({
  name:        z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
  status:      z.enum(['active', 'archived']).optional(),
});

const updateConfigSchema = z.object({
  systemPrompt:    z.string().max(20000),
  desktopPersonaPrompt: z.string().max(6000).optional(),
  managerApproval: z.unknown().optional(),
  isActive:        z.boolean().optional(),
  /*
   * Whether this department is offered Divo's chat assistant. Optional, so a
   * caller that has never heard of it leaves whatever is set alone rather than
   * silently switching chat back on for a department that turned it off.
   */
  chatEnabled:     z.boolean().optional(),
});

const createRoleSchema = z.object({
  name:          z.string().min(1).max(120),
  slug:          z.string().min(1).max(120),
  zohoReadScope: z.enum(['personalized', 'show_all']).optional(),
});

const updateRoleSchema = z.object({
  name:          z.string().min(1).max(120),
  isDefault:     z.boolean().optional(),
  zohoReadScope: z.enum(['personalized', 'show_all']).optional(),
});

const upsertMembershipSchema = z.object({
  userId:            z.string().uuid().optional(),
  channelIdentityId: z.string().uuid().optional(),
  roleId:            z.string().uuid().optional(),
  status:            z.enum(['active', 'inactive']).optional(),
});

const allowedSchema = z.object({ allowed: z.boolean() });
const detailSectionSchema = z.enum(['overview', 'roles', 'members', 'permissions', 'config']);

// ── Route factory ─────────────────────────────────────────────────────────────

export function createDepartmentRoutes(deps: DepartmentRoutesDeps): Router {
  const router = Router();
  const svc    = deps.deptAdminService;

  // ── List departments ──────────────────────────────────────────────────────
  router.get('/', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const rawLimit  = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const limit     = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : undefined;
    const result    = await svc.listDepartments(companyId, limit);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Departments loaded');
  }));

  // ── Department detail ─────────────────────────────────────────────────────
  router.get('/:id', asyncRoute(async (req, res) => {
    const { id }    = req.params as { id: string };
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const sections  = typeof req.query.sections === 'string' && req.query.sections.trim()
      ? req.query.sections
          .split(',')
          .map(section => detailSectionSchema.parse(section.trim()))
      : undefined;
    const result    = await svc.getDepartmentDetail(id, companyId, sections);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department detail loaded');
  }));

  // ── Member candidate search ───────────────────────────────────────────────
  router.get('/:id/candidates', asyncRoute(async (req, res) => {
    const { id }    = req.params as { id: string };
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const query     = z.string().min(1).max(200).parse(req.query.query ?? '');
    const result    = await svc.searchCandidates(id, companyId, query);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department candidates loaded');
  }));

  // ── Backfill empty role permission matrices ───────────────────────────────
  // Seeds MEMBER-template grants for roles that currently have zero rows.
  // Optional body.departmentId limits the backfill to one department.
  router.post('/backfill-permissions', asyncRoute(async (req, res) => {
    const payload = z.object({
      companyId:     z.string().min(1).optional(),
      departmentId:  z.string().min(1).optional(),
    }).parse(req.body ?? {});
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId    = resolveUserId(res);
    const result    = await svc.backfillEmptyRolePermissions(companyId, userId, payload.departmentId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department permissions backfilled');
  }));

  // ── Create department ─────────────────────────────────────────────────────
  router.post('/', asyncRoute(async (req, res) => {
    const payload   = createDeptSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId    = resolveUserId(res);
    const result    = await svc.createDepartment(companyId, userId, { name: payload.name, description: payload.description });
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department created', 201);
  }));

  // ── Update department ─────────────────────────────────────────────────────
  router.put('/:id', asyncRoute(async (req, res) => {
    const { id }    = req.params as { id: string };
    const payload   = updateDeptSchema.parse(req.body);
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result    = await svc.updateDepartment(id, companyId, payload);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department updated');
  }));

  // ── Archive department ────────────────────────────────────────────────────
  router.post('/:id/archive', asyncRoute(async (req, res) => {
    const { id }    = req.params as { id: string };
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result    = await svc.archiveDepartment(id, companyId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department archived');
  }));

  // ── Update config ─────────────────────────────────────────────────────────
  router.put('/:id/config', asyncRoute(async (req, res) => {
    const { id }    = req.params as { id: string };
    const payload   = updateConfigSchema.parse(req.body);
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const userId    = resolveUserId(res);
    const result    = await svc.updateConfig(id, companyId, userId, payload);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department configuration updated');
  }));

  // ── Create role ───────────────────────────────────────────────────────────
  router.post('/:id/roles', asyncRoute(async (req, res) => {
    const { id }    = req.params as { id: string };
    const payload   = createRoleSchema.parse(req.body);
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result    = await svc.createRole(id, companyId, payload);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department role created', 201);
  }));

  // ── Update role ───────────────────────────────────────────────────────────
  router.put('/:id/roles/:roleId', asyncRoute(async (req, res) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const payload        = updateRoleSchema.parse(req.body);
    const companyId      = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result         = await svc.updateRole(id, companyId, roleId, payload);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department role updated');
  }));

  // ── Delete role ───────────────────────────────────────────────────────────
  router.delete('/:id/roles/:roleId', asyncRoute(async (req, res) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const companyId      = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result         = await svc.deleteRole(id, companyId, roleId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department role deleted');
  }));

  // ── Upsert membership ─────────────────────────────────────────────────────
  router.put('/:id/memberships', asyncRoute(async (req, res) => {
    const { id }    = req.params as { id: string };
    const payload   = upsertMembershipSchema.parse(req.body);
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result    = await svc.upsertMembership(id, companyId, payload);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department membership saved');
  }));

  // ── Remove membership ─────────────────────────────────────────────────────
  router.delete('/:id/memberships/:userId', asyncRoute(async (req, res) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const companyId      = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result         = await svc.removeMembership(id, companyId, userId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department membership removed');
  }));

  // Keep the old URLs as explicit fail-closed guards during client rollout.
  // Skill content is shared knowledge and must never be written by an admin
  // CRUD endpoint because that would skip requester review, distinct approval,
  // immutable versions, and the projection outbox.
  const rejectLegacySkillWrite = (_req: Request, res: Response): void => {
    fail(
      res,
      409,
      'Direct skill writes are disabled. Use the governed knowledge review flow.',
    );
  };
  router.post('/:id/skills', rejectLegacySkillWrite);
  router.put('/:id/skills/:skillId', rejectLegacySkillWrite);
  router.post('/:id/skills/:skillId/archive', rejectLegacySkillWrite);

  // ── Role permission ───────────────────────────────────────────────────────
  router.put('/:id/role-permissions/:roleId/:toolId/:actionGroup', asyncRoute(async (req, res) => {
    const { id, roleId, toolId, actionGroup } = req.params as { id: string; roleId: string; toolId: string; actionGroup: string };
    const { allowed } = allowedSchema.parse(req.body);
    const companyId   = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const userId      = resolveUserId(res);
    const result      = await svc.updateRolePermission(id, companyId, roleId, toolId, actionGroup, allowed, userId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department role permission updated');
  }));

  // ── User override ─────────────────────────────────────────────────────────
  router.put('/:id/user-overrides/:userId/:toolId/:actionGroup', asyncRoute(async (req, res) => {
    const { id, userId, toolId, actionGroup } = req.params as { id: string; userId: string; toolId: string; actionGroup: string };
    const { allowed } = allowedSchema.parse(req.body);
    const companyId   = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const actorId     = resolveUserId(res);
    const result      = await svc.updateUserOverride(id, companyId, userId, toolId, actionGroup, allowed, actorId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Department user override updated');
  }));

  // ── Books module permissions ───────────────────────────────────────────────
  router.get('/:id/books-modules', asyncRoute(async (req, res) => {
    const { id } = req.params as { id: string };
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const result    = await svc.getBookModulePermissions(id, companyId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Books module permissions loaded');
  }));

  router.put('/:id/books-modules/:roleId/:module', asyncRoute(async (req, res) => {
    const { id, roleId, module: mod } = req.params as { id: string; roleId: string; module: string };
    const { allowed } = allowedSchema.parse(req.body);
    const companyId   = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const userId      = resolveUserId(res);
    const result      = await svc.updateBookModulePermission(id, companyId, roleId, mod, allowed, userId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value, 'Books module permission updated');
  }));

  return router;
}
