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
const managerApprovalSchema = z.object({
  enabled: z.boolean(),
  requiredActions: z.array(z.object({
    toolId: z.string().trim().min(1).max(120),
    actions: z.array(z.string().trim().min(1).max(60)).max(20),
  }).strict()).max(50),
}).strict();
const zohoScopeSchema = z.object({ personalized: z.boolean() }).strict();
/* The whole selection, not a delta — the same contract as the manager policy
   above it. Capped for the same reason: a stored gate is read on every gated
   tool call, so it has to stay small enough to be free to read. */
const personalApprovalsSchema = z.object({
  all: z.boolean(),
  actions: z.array(z.object({
    toolId: z.string().trim().min(1).max(120),
    actions: z.array(z.string().trim().min(1).max(60)).max(20),
  }).strict()).max(50),
}).strict();

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

/** Member-authenticated team routes. Writes stay department-manager-only. */
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

  /* Deliberately not under `/departments/:id`. It is about the person asking,
     not about a department they administer, and every member may read it —
     which is the difference between this and the manager-only policy route
     below. */
  router.get('/me/approval-forecast', memberAuth, async (_req: Request, res: Response) => {
    try { res.json(await deps.service.approvalForecast(actor(res))); } catch (error) { respondError(res, error); }
  });

  /* Member auth, not manager auth. Choosing to be shown more of your own work
     is not a privilege, so every signed-in person may write their own. */
  router.put('/me/personal-approvals', memberAuth, async (req: Request, res: Response) => {
    const parsed = personalApprovalsSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'Send { all, actions: [{ toolId, actions }] }' }); return; }
    try { res.json(await deps.service.setPersonalApprovals(actor(res), parsed.data)); } catch (error) { respondError(res, error); }
  });

  router.get('/departments/:departmentId/manager-approval', memberAuth, async (req: Request, res: Response) => {
    try { res.json(await deps.service.managerApprovalPolicy(actor(res), req.params.departmentId!)); } catch (error) { respondError(res, error); }
  });

  router.put('/departments/:departmentId/manager-approval', memberAuth, async (req: Request, res: Response) => {
    const parsed = managerApprovalSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'enabled and requiredActions are required' }); return; }
    try { res.json(await deps.service.setManagerApprovalPolicy(actor(res), req.params.departmentId!, parsed.data)); } catch (error) { respondError(res, error); }
  });

  router.put('/departments/:departmentId/roles/:roleId/zoho-scope', memberAuth, async (req: Request, res: Response) => {
    const parsed = zohoScopeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'personalized is required' }); return; }
    try { res.json(await deps.service.setZohoPersonalizedScope(actor(res), req.params.departmentId!, req.params.roleId!, parsed.data.personalized)); } catch (error) { respondError(res, error); }
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
