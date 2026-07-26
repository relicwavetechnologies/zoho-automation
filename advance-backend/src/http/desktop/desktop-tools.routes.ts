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
import type { CompanySerperConnectionRepository } from '../../infrastructure/persistence/company-serper-connection.repository';
import type { CompanySerperService } from '../../application/web-search/company-serper.service';
import type { CompanyOmsConnectionRepository } from '../../infrastructure/persistence/company-oms-connection.repository';
import type { CompanyOmsSiteDataService } from '../../application/oms/company-oms-site-data.service';

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
  serperConnectionRepo: CompanySerperConnectionRepository;
  serperService: CompanySerperService;
  omsConnectionRepo: CompanyOmsConnectionRepository;
  omsSiteDataService: CompanyOmsSiteDataService;
}

const enabledSchema = z.object({ enabled: z.boolean() });
const allowedSchema = z.object({ allowed: z.boolean() });
const scopeSchema = z.union([
  z.object({ scope: z.literal('global') }).strict(),
  z.object({ scope: z.literal('department'), departmentId: z.string().uuid() }).strict(),
]);
const serperTestSchema = z.object({ apiKey: z.string().min(1).max(512) }).strict();
const serperSaveSchema = z.object({ label: z.string().trim().min(1).max(100), apiKey: z.string().min(1).max(512), verificationToken: z.string().uuid(), remainingCredits: z.number().int().min(0).max(100_000_000).optional() }).strict();
const serperStatusSchema = z.object({ enabled: z.boolean() }).strict();
const serperCreditsSchema = z.object({ remainingCredits: z.number().int().min(0).max(100_000_000) }).strict();
const omsTestSchema = z.object({ apiKey: z.string().min(1).max(512) }).strict();
const omsSaveSchema = z.object({ label: z.string().trim().min(1).max(100), apiKey: z.string().min(1).max(512), verificationToken: z.string().uuid() }).strict();
const omsStatusSchema = z.object({ enabled: z.boolean() }).strict();

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

function requireCompanyAdmin(res: Response): boolean {
  const role = res.locals.aiRole as string;
  if (role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN') return true;
  res.status(403).json({ error: 'forbidden', message: 'Only company admins can manage company-owned provider connections' });
  return false;
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

  // Configured reach of the whole catalogue in one department. The tools list
  // needs this for every row at once; `/tools/:toolId/manage` is the drill-down.
  router.get('/tools/coverage/:departmentId', memberAuth, async (req: Request, res: Response) => {
    try { res.json(await service.coverage(actor(res), req.params.departmentId!)); } catch (error) { respondError(res, error); }
  });

  router.get('/tools/:toolId/manage', memberAuth, async (req: Request, res: Response) => {
    const parsed = scopeSchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'scope must be global or department with a departmentId' }); return; }
    try {
      const scope = parsed.data.scope === 'global' ? { kind: 'global' as const } : { kind: 'department' as const, departmentId: parsed.data.departmentId };
      res.json(await service.snapshot(actor(res), req.params.toolId!, scope));
    } catch (error) { respondError(res, error); }
  });

  // Company-shared Serper credentials. Keys are accepted only by the test/save
  // flow and are never sent back to the desktop after encryption.
  router.get('/tools/webSearch/connections', memberAuth, async (_req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    res.json({ connections: await deps.serperConnectionRepo.list(res.locals.companyId as string) });
  });

  router.post('/tools/webSearch/connections/test', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const parsed = serperTestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'apiKey is required' }); return; }
    try {
      res.json(await deps.serperService.verify(res.locals.companyId as string, res.locals.userId as string, parsed.data.apiKey));
    } catch (error) {
      res.status(422).json({ error: 'connection_test_failed', message: error instanceof Error ? error.message : 'Unable to verify this Serper API key' });
    }
  });

  router.post('/tools/webSearch/connections', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const parsed = serperSaveSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'label, apiKey, and verificationToken are required' }); return; }
    try {
      res.status(201).json({ connection: await deps.serperService.saveVerified({
        companyId: res.locals.companyId as string,
        userId: res.locals.userId as string,
        label: parsed.data.label,
        apiKey: parsed.data.apiKey,
        verificationToken: parsed.data.verificationToken,
        ...(parsed.data.remainingCredits === undefined ? {} : { remainingCredits: parsed.data.remainingCredits }),
      }) });
    } catch (error) {
      res.status(422).json({ error: 'connection_not_verified', message: error instanceof Error ? error.message : 'Test the key before saving it' });
    }
  });

  router.patch('/tools/webSearch/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const parsed = serperStatusSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'enabled must be a boolean' }); return; }
    const connection = await deps.serperConnectionRepo.setStatus(res.locals.companyId as string, req.params.connectionId!, parsed.data.enabled ? 'connected' : 'disabled');
    if (!connection) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ connection });
  });

  // Serper does not expose a supported balance endpoint for API-key-only clients.
  // Admins copy the current balance from Serper; Divo then subtracts requests it observes.
  router.put('/tools/webSearch/connections/:connectionId/credits', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const parsed = serperCreditsSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'remainingCredits must be a non-negative integer' }); return; }
    const connection = await deps.serperConnectionRepo.setRemainingCredits(res.locals.companyId as string, req.params.connectionId!, parsed.data.remainingCredits);
    if (!connection) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ connection });
  });

  router.delete('/tools/webSearch/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const deleted = await deps.serperConnectionRepo.revoke(res.locals.companyId as string, req.params.connectionId!);
    if (!deleted) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ success: true });
  });

  // OMS Site Data is an admin-only, company-owned read capability. Like every
  // provider connection, raw credentials are accepted only during test/save.
  router.get('/tools/omsSiteData/connections', memberAuth, async (_req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    res.json({ connections: await deps.omsConnectionRepo.list(res.locals.companyId as string) });
  });

  router.post('/tools/omsSiteData/connections/test', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const parsed = omsTestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'apiKey is required' }); return; }
    try {
      res.json(await deps.omsSiteDataService.verify(res.locals.companyId as string, res.locals.userId as string, parsed.data.apiKey));
    } catch (error) {
      res.status(422).json({ error: 'connection_test_failed', message: error instanceof Error ? error.message : 'Unable to verify this OMS Site Data API key' });
    }
  });

  router.post('/tools/omsSiteData/connections', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const parsed = omsSaveSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'label, apiKey, and verificationToken are required' }); return; }
    try {
      const connection = await deps.omsSiteDataService.saveVerified({
        companyId: res.locals.companyId as string,
        userId: res.locals.userId as string,
        label: parsed.data.label,
        apiKey: parsed.data.apiKey,
        verificationToken: parsed.data.verificationToken,
      });
      deps.auditService.record({
        actorId: res.locals.userId as string,
        companyId: res.locals.companyId as string,
        action: 'oms.site_data.connection_saved',
        outcome: 'success',
        metadata: { connectionId: connection.id },
      });
      res.status(201).json({ connection });
    } catch (error) {
      res.status(422).json({ error: 'connection_not_verified', message: error instanceof Error ? error.message : 'Test the exact OMS Site Data key before saving it' });
    }
  });

  router.patch('/tools/omsSiteData/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const parsed = omsStatusSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'bad_request', message: 'enabled must be a boolean' }); return; }
    const connection = await deps.omsConnectionRepo.setStatus(res.locals.companyId as string, req.params.connectionId!, parsed.data.enabled ? 'connected' : 'disabled');
    if (!connection) { res.status(404).json({ error: 'not_found' }); return; }
    deps.auditService.record({
      actorId: res.locals.userId as string,
      companyId: res.locals.companyId as string,
      action: 'oms.site_data.connection_status',
      outcome: 'success',
      metadata: { connectionId: connection.id, enabled: parsed.data.enabled },
    });
    res.json({ connection });
  });

  router.delete('/tools/omsSiteData/connections/:connectionId', memberAuth, async (req: Request, res: Response) => {
    if (!requireCompanyAdmin(res)) return;
    const deleted = await deps.omsConnectionRepo.revoke(res.locals.companyId as string, req.params.connectionId!);
    if (!deleted) { res.status(404).json({ error: 'not_found' }); return; }
    deps.auditService.record({
      actorId: res.locals.userId as string,
      companyId: res.locals.companyId as string,
      action: 'oms.site_data.connection_revoked',
      outcome: 'success',
      metadata: { connectionId: req.params.connectionId! },
    });
    res.json({ success: true });
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
