import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { PermissionService } from '../../application/permissions/permission.service';
import { PermissionWriteService } from '../../application/permissions/permission-write.service';
import { DesktopToolAccessError, DesktopToolAccessService } from '../../application/desktop/desktop-tool-access.service';
import type { ToolActionPermissionRepoPort } from '../../infrastructure/persistence/tool-action-permission.repository';
import type { ToolPermissionRepoPort } from '../../infrastructure/persistence/tool-permission.repository';
import type { CompanyRoleRepoPort } from '../../infrastructure/persistence/company-role.repository';
import type { DeptToolPermissionRepoPort } from '../../infrastructure/persistence/department-tool-permission.repository';
import type { DeptUserOverrideRepoPort } from '../../infrastructure/persistence/department-user-override.repository';
import type { IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import type { AuditService } from '../../application/observability/audit.service';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import type { ToolRegistry } from '../../application/orchestration/tools/tool-registry';

export interface DesktopToolsRouteDeps {
  prisma: PrismaClient;
  memberJwtSecret: string;
  logger: Logger;
  permissions: PermissionService;
  toolActionRepo: ToolActionPermissionRepoPort;
  toolPermRepo: ToolPermissionRepoPort;
  companyRoleRepo: CompanyRoleRepoPort;
  deptToolPermRepo: DeptToolPermissionRepoPort;
  deptUserOverrideRepo: DeptUserOverrideRepoPort;
  connectionRepo: IntegrationConnectionRepository;
  auditService: AuditService;
  toolRegistry: ToolRegistry;
}

const enabledSchema = z.object({ enabled: z.boolean() });
const allowedSchema = z.object({ allowed: z.boolean() });
const scopeSchema = z.union([
  z.object({ scope: z.literal('global') }).strict(),
  z.object({ scope: z.literal('department'), departmentId: z.string().uuid() }).strict(),
]);

function actor(res: Response) {
  return { userId: res.locals.userId as string, companyId: res.locals.companyId as string, role: res.locals.aiRole as string };
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof DesktopToolAccessError) {
    const status = error.code === 'forbidden' ? 403 : error.code === 'invalid' ? 400 : 500;
    res.status(status).json({ error: error.code === 'internal' ? 'internal_error' : error.code, message: error.code === 'forbidden' ? 'Current membership is not authorised for this scope' : 'Invalid tool, action, scope, or target' });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'Unable to load desktop tools' });
}

/** Member-auth desktop-only tools inventory and tightly scoped RBAC management API. */
export function createDesktopToolsRoutes(deps: DesktopToolsRouteDeps): Router {
  const router = Router();
  const memberAuth = createMemberAuthMiddleware({ prisma: deps.prisma, jwtSecret: deps.memberJwtSecret, logger: deps.logger });
  const writes = new PermissionWriteService({
    toolActionRepo: deps.toolActionRepo,
    deptToolPermRepo: deps.deptToolPermRepo,
    deptUserOverrideRepo: deps.deptUserOverrideRepo,
    permissions: deps.permissions,
    auditService: deps.auditService,
    toolRegistry: deps.toolRegistry,
  });
  const service = new DesktopToolAccessService({
    prisma: deps.prisma,
    permissions: deps.permissions,
    permissionWrites: writes,
    toolActionRepo: deps.toolActionRepo,
    toolPermRepo: deps.toolPermRepo,
    companyRoleRepo: deps.companyRoleRepo,
    connectionRepo: deps.connectionRepo,
    toolRegistry: deps.toolRegistry,
    logger: deps.logger.child({ service: 'desktop-tools-catalogue' }),
  });

  router.get('/tools', memberAuth, async (_req: Request, res: Response) => {
    try { res.json(await service.inventory(actor(res))); } catch (error) { respondError(res, error); }
  });

  router.get('/tools/:toolId/manage', memberAuth, async (req: Request, res: Response) => {
    const parsed = scopeSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'scope must be global or department with a departmentId' }); return; }
    try {
      const scope = parsed.data.scope === 'global' ? { kind: 'global' as const } : { kind: 'department' as const, departmentId: parsed.data.departmentId };
      res.json(await service.snapshot(actor(res), req.params.toolId!, scope));
    } catch (error) { respondError(res, error); }
  });

  router.put('/tools/:toolId/global/roles/:role/actions/:actionGroup', memberAuth, async (req: Request, res: Response) => {
    const parsed = enabledSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'enabled must be a boolean' }); return; }
    try { res.json(await service.setGlobal(actor(res), req.params.toolId!, req.params.role!, req.params.actionGroup!, parsed.data.enabled)); } catch (error) { respondError(res, error); }
  });

  router.put('/tools/:toolId/departments/:departmentId/roles/:roleId/actions/:actionGroup', memberAuth, async (req: Request, res: Response) => {
    const parsed = allowedSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'allowed must be a boolean' }); return; }
    try { res.json(await service.setDepartmentRole(actor(res), req.params.toolId!, req.params.departmentId!, req.params.roleId!, req.params.actionGroup!, parsed.data.allowed)); } catch (error) { respondError(res, error); }
  });

  router.put('/tools/:toolId/departments/:departmentId/members/:userId/actions/:actionGroup', memberAuth, async (req: Request, res: Response) => {
    const parsed = allowedSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'allowed must be a boolean' }); return; }
    try { res.json(await service.setDepartmentMember(actor(res), req.params.toolId!, req.params.departmentId!, req.params.userId!, req.params.actionGroup!, parsed.data.allowed)); } catch (error) { respondError(res, error); }
  });

  return router;
}
