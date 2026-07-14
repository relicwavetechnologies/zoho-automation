/**
 * Skill Registry admin routes — the backend behind the Skills Lab admin area.
 *
 * All routes require admin auth. Mounted at /api/admin/skill-registry.
 * Company admins are scoped to their own workspace; super-admins pass companyId.
 *
 *   GET    /tree                          — full folder + skill tree
 *   POST   /folders                       — create folder
 *   PUT    /folders/:folderId             — rename folder
 *   POST   /folders/:folderId/move        — move folder
 *   POST   /folders/:folderId/archive     — archive folder (cascade)
 *   POST   /skills/:skillId/move          — move a skill into a folder / to root
 *   POST   /backfill                      — organize existing skills into starter folders
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { SkillRegistryAdminService } from '../../application/skills/skill-registry-admin.service';
import type { AuditService } from '../../application/observability/audit.service';
import type { Logger } from '../../shared/logger';

export interface SkillRegistryRoutesDeps {
  skillRegistryService: SkillRegistryAdminService;
  auditService?: Pick<AuditService, 'record'>;
  logger: Logger;
}

// ── Shared helpers (mirrors departments.routes.ts) ───────────────────────────
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
      const status = (error as RouteError)?.status ?? 500;
      fail(res, status, error instanceof Error ? error.message : 'Internal error');
    }
  };

function resolveCompanyId(res: Response, providedId?: string): string {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  const localId = (res.locals['companyId'] as string | undefined) ?? '';
  if (isSuperAdmin) {
    if (!providedId) throw routeError(400, 'companyId is required for super-admin requests');
    return providedId;
  }
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId;
}

function resolveUserId(res: Response): string {
  return (res.locals['userId'] as string | undefined) ?? 'unknown';
}

function resolveServiceError(res: Response, error: { kind: string; message: string }): void {
  const statusMap: Record<string, number> = {
    not_found: 404,
    conflict: 409,
    validation: 400,
    forbidden: 403,
    internal: 500,
  };
  fail(res, statusMap[error.kind] ?? 500, error.message);
}

const companyQuery = (req: Request): string | undefined =>
  typeof req.query.companyId === 'string' ? req.query.companyId : undefined;

// ── Input schemas ────────────────────────────────────────────────────────────
const createFolderSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  parentId: z.string().uuid().nullish(),
  departmentId: z.string().uuid().nullish(),
});
const renameFolderSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
});
const moveFolderSchema = z.object({
  companyId: z.string().uuid().optional(),
  parentId: z.string().uuid().nullish(),
});
const moveSkillSchema = z.object({
  companyId: z.string().uuid().optional(),
  folderId: z.string().uuid().nullable(),
});
const backfillSchema = z.object({ companyId: z.string().uuid().optional() });
const grantSkillSchema = z.object({
  companyId: z.string().uuid().optional(),
  granteeType: z.enum(['user', 'department', 'role', 'company']),
  granteeId: z.string().uuid(),
});

// ── Route factory ────────────────────────────────────────────────────────────
export function createSkillRegistryRoutes(deps: SkillRegistryRoutesDeps): Router {
  const router = Router();
  const svc = deps.skillRegistryService;

  const auditFolder = (
    companyId: string,
    userId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) => deps.auditService?.record({ actorId: userId, companyId, action, outcome: 'success', metadata });

  // ── Tree ──────────────────────────────────────────────────────────────────
  router.get('/tree', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, companyQuery(req));
    const includeArchived = req.query.includeArchived === 'true';
    const result = await svc.getTree(companyId, { includeArchived });
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value);
  }));

  // ── Create folder ───────────────────────────────────────────────────────────
  router.post('/folders', asyncRoute(async (req, res) => {
    const payload = createFolderSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId = resolveUserId(res);
    const result = await svc.createFolder(companyId, userId, {
      name: payload.name,
      parentId: payload.parentId ?? null,
      departmentId: payload.departmentId ?? null,
    });
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.folder.create', { folderId: result.value.id });
    success(res, result.value, 'Folder created', 201);
  }));

  // ── Rename folder ─────────────────────────────────────────────────────────
  router.put('/folders/:folderId', asyncRoute(async (req, res) => {
    const { folderId } = req.params as { folderId: string };
    const payload = renameFolderSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId = resolveUserId(res);
    const result = await svc.renameFolder(companyId, folderId, userId, { name: payload.name });
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.folder.rename', { folderId });
    success(res, result.value, 'Folder renamed');
  }));

  // ── Move folder ─────────────────────────────────────────────────────────────
  router.post('/folders/:folderId/move', asyncRoute(async (req, res) => {
    const { folderId } = req.params as { folderId: string };
    const payload = moveFolderSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId = resolveUserId(res);
    const result = await svc.moveFolder(companyId, folderId, userId, { parentId: payload.parentId ?? null });
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.folder.move', { folderId, parentId: payload.parentId ?? null });
    success(res, result.value, 'Folder moved');
  }));

  // ── Archive folder ────────────────────────────────────────────────────────
  router.post('/folders/:folderId/archive', asyncRoute(async (req, res) => {
    const { folderId } = req.params as { folderId: string };
    const companyId = resolveCompanyId(res, companyQuery(req));
    const userId = resolveUserId(res);
    const result = await svc.archiveFolder(companyId, folderId, userId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.folder.archive', { folderId, ...result.value });
    success(res, result.value, 'Folder archived');
  }));

  // ── Skill detail ──────────────────────────────────────────────────────────
  router.get('/skills/:skillId', asyncRoute(async (req, res) => {
    const { skillId } = req.params as { skillId: string };
    const companyId = resolveCompanyId(res, companyQuery(req));
    const result = await svc.getSkillDetail(companyId, skillId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value);
  }));

  // ── Skill access (per-skill RBAC grants) ────────────────────────────────────
  router.get('/skills/:skillId/access', asyncRoute(async (req, res) => {
    const { skillId } = req.params as { skillId: string };
    const companyId = resolveCompanyId(res, companyQuery(req));
    const result = await svc.getSkillAccess(companyId, skillId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value);
  }));

  // ── Grant a skill to a grantee (user / department / role / company) ─────────
  router.post('/skills/:skillId/access', asyncRoute(async (req, res) => {
    const { skillId } = req.params as { skillId: string };
    const payload = grantSkillSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId = resolveUserId(res);
    const result = await svc.grantSkillAccess(companyId, skillId, payload.granteeType, payload.granteeId, userId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.access.grant', { skillId, granteeType: payload.granteeType, granteeId: payload.granteeId });
    success(res, result.value, 'Skill access granted', 201);
  }));

  // ── Revoke a skill grant ────────────────────────────────────────────────────
  router.delete('/skills/:skillId/access/:granteeType/:granteeId', asyncRoute(async (req, res) => {
    const { skillId, granteeType, granteeId } = req.params as { skillId: string; granteeType: string; granteeId: string };
    if (!['user', 'department', 'role', 'company'].includes(granteeType)) { fail(res, 400, 'Invalid grantee type'); return; }
    const companyId = resolveCompanyId(res, companyQuery(req));
    const userId = resolveUserId(res);
    const result = await svc.revokeSkillAccess(companyId, skillId, granteeType as 'user' | 'department' | 'role' | 'company', granteeId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.access.revoke', { skillId, granteeType, granteeId });
    success(res, result.value, 'Skill access revoked');
  }));

  // ── Skill audit trail ─────────────────────────────────────────────────────
  router.get('/skills/:skillId/audit', asyncRoute(async (req, res) => {
    const { skillId } = req.params as { skillId: string };
    const companyId = resolveCompanyId(res, companyQuery(req));
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const result = await svc.getSkillAudit(companyId, skillId, {
      ...(Number.isFinite(limit) ? { limit: limit as number } : {}),
    });
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    success(res, result.value);
  }));

  // ── Move skill ──────────────────────────────────────────────────────────────
  router.post('/skills/:skillId/move', asyncRoute(async (req, res) => {
    const { skillId } = req.params as { skillId: string };
    const payload = moveSkillSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId = resolveUserId(res);
    const result = await svc.moveSkill(companyId, skillId, userId, { folderId: payload.folderId });
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.move', { skillId, folderId: payload.folderId });
    success(res, result.value, 'Skill moved');
  }));

  // ── Backfill ────────────────────────────────────────────────────────────────
  router.post('/backfill', asyncRoute(async (req, res) => {
    const payload = backfillSchema.parse(req.body ?? {});
    const companyId = resolveCompanyId(res, payload.companyId);
    const userId = resolveUserId(res);
    const result = await svc.backfillFolders(companyId, userId);
    if (!result.ok) { resolveServiceError(res, result.error); return; }
    auditFolder(companyId, userId, 'skill.folder.backfill', result.value);
    success(res, result.value, 'Skill folders backfilled');
  }));

  return router;
}
