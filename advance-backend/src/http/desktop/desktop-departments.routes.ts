import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import {
  DesktopDepartmentManagementError,
  DesktopDepartmentManagementService,
} from '../../application/desktop/desktop-department-management.service';

export interface DesktopDepartmentRoutesDeps {
  prisma: PrismaClient;
  memberJwtSecret: string;
  logger: Logger;
  service: DesktopDepartmentManagementService;
}

const roleCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(1).max(40),
}).strict();
const roleUpdateSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const membershipSchema = z.object({ userId: z.string().trim().min(1), roleId: z.string().trim().min(1) }).strict();
const candidateQuerySchema = z.object({ query: z.string().trim().min(1).max(120) });

function actor(res: Response) {
  return { userId: res.locals.userId as string, companyId: res.locals.companyId as string };
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof DesktopDepartmentManagementError) {
    const status = error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : error.code === 'invalid' ? 400 : 500;
    res.status(status).json({ error: error.code === 'internal' ? 'internal_error' : error.code, message: error.message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'Unable to manage this department' });
}

/** Member-authenticated, department-manager-only team and custom-role routes. */
export function createDesktopDepartmentRoutes(deps: DesktopDepartmentRoutesDeps): Router {
  const router = Router();
  const memberAuth = createMemberAuthMiddleware({ prisma: deps.prisma, jwtSecret: deps.memberJwtSecret, logger: deps.logger });

  router.get('/departments/:departmentId/manage', memberAuth, async (req: Request, res: Response) => {
    try { res.json(await deps.service.snapshot(actor(res), req.params.departmentId!)); } catch (error) { respondError(res, error); }
  });

  router.get('/departments/:departmentId/candidates', memberAuth, async (req: Request, res: Response) => {
    const parsed = candidateQuerySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'query is required' }); return; }
    try { res.json(await deps.service.searchCandidates(actor(res), req.params.departmentId!, parsed.data.query)); } catch (error) { respondError(res, error); }
  });

  router.post('/departments/:departmentId/roles', memberAuth, async (req: Request, res: Response) => {
    const parsed = roleCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'name and slug are required' }); return; }
    try { res.status(201).json(await deps.service.createRole(actor(res), req.params.departmentId!, parsed.data)); } catch (error) { respondError(res, error); }
  });

  router.put('/departments/:departmentId/roles/:roleId', memberAuth, async (req: Request, res: Response) => {
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'name is required' }); return; }
    try { res.json(await deps.service.updateRole(actor(res), req.params.departmentId!, req.params.roleId!, parsed.data)); } catch (error) { respondError(res, error); }
  });

  router.delete('/departments/:departmentId/roles/:roleId', memberAuth, async (req: Request, res: Response) => {
    try { res.json(await deps.service.deleteRole(actor(res), req.params.departmentId!, req.params.roleId!)); } catch (error) { respondError(res, error); }
  });

  router.put('/departments/:departmentId/memberships', memberAuth, async (req: Request, res: Response) => {
    const parsed = membershipSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'userId and roleId are required' }); return; }
    try { res.json(await deps.service.upsertMembership(actor(res), req.params.departmentId!, parsed.data)); } catch (error) { respondError(res, error); }
  });

  router.delete('/departments/:departmentId/memberships/:userId', memberAuth, async (req: Request, res: Response) => {
    try { res.json(await deps.service.removeMembership(actor(res), req.params.departmentId!, req.params.userId!)); } catch (error) { respondError(res, error); }
  });

  return router;
}
