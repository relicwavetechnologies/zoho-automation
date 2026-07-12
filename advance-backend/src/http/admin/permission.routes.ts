import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ToolPermissionRepoPort } from '../../infrastructure/persistence/tool-permission.repository';
import type { ToolActionPermissionRepoPort } from '../../infrastructure/persistence/tool-action-permission.repository';
import type { DeptToolPermissionRepoPort } from '../../infrastructure/persistence/department-tool-permission.repository';
import type { PermissionService } from '../../application/permissions/permission.service';
import type { Logger } from '../../shared/logger';
import type { AuditService } from '../../application/observability/audit.service';
import type { PermissionWriteService } from '../../application/permissions/permission-write.service';
import { isFixedToolPolicy } from '../../domain/tools/tool-policy';
import {
  CANONICAL_TOOL_IDS,
  TOOL_SUPPORTED_ACTIONS,
  TOOL_DEFAULT_PERMISSIONS,
} from '../../domain/tools/tool-id';

export interface AdminPermissionRouteDeps {
  toolPermRepo: ToolPermissionRepoPort;
  toolActionRepo: ToolActionPermissionRepoPort;
  deptToolPermRepo: DeptToolPermissionRepoPort;
  permissions: PermissionService;
  logger: Logger;
  auditService: AuditService;
  /** All action writes use this runtime-validating shared writer. */
  permissionWrites: PermissionWriteService;
}

// ── Request body schemas ───────────────────────────────────────────────────

const SetToolPermSchema = z.object({
  role:       z.string().min(1),
  enabled:    z.boolean(),
  updatedBy:  z.string().optional(),
});

const SetActionPermSchema = z.object({
  role:        z.string().min(1),
  enabled:     z.boolean(),
  updatedBy:   z.string().optional(),
});

const SetDeptPermSchema = z.object({
  roleId:     z.string().min(1),
  allowed:    z.boolean(),
  updatedBy:  z.string().min(1),
});

// ── Helper: send validation error ─────────────────────────────────────────

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: 'bad_request', message });
}

// ── Route factory ──────────────────────────────────────────────────────────

export const createAdminPermissionRoutes = (deps: AdminPermissionRouteDeps): Router => {
  const router = Router();
  const log = deps.logger.child({ route: 'admin-permissions' });
  const { auditService } = deps;

  // Helper: extract actor from request (x-actor-id header or 'system' fallback)
  const actorId = (req: Request) =>
    (req.headers['x-actor-id'] as string | undefined) ?? 'system';

  // ── GET /companies/:companyId/matrix ────────────────────────────────────
  // Returns the full permission matrix: for each tool, each built-in role's
  // effective enabled state plus per-action overrides stored in the DB.
  router.get('/companies/:companyId/matrix', async (req: Request, res: Response) => {
    const { companyId } = req.params as { companyId: string };

    const [toolPermResult, actionPermResult] = await Promise.all([
      deps.toolPermRepo.getForCompany(companyId),
      deps.toolActionRepo.getForCompany(companyId),
    ]);

    if (!toolPermResult.ok || !actionPermResult.ok) {
      log.error('admin.matrix.db_error', { companyId });
      res.status(500).json({ error: 'internal_error', message: 'Failed to load permissions' });
      return;
    }

    // Build override maps
    const toolOverrides = new Map<string, boolean>();
    for (const r of toolPermResult.value) {
      toolOverrides.set(`${r.role}:${r.toolId}`, r.enabled);
    }
    const actionOverrides = new Map<string, boolean>();
    for (const r of actionPermResult.value) {
      actionOverrides.set(`${r.role}:${r.toolId}:${r.actionGroup}`, r.enabled);
    }

    const builtInRoles = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'] as const;

    const matrix = CANONICAL_TOOL_IDS.map(toolId => {
      const roles: Record<string, { enabled: boolean; source: string; actions: Record<string, { enabled: boolean; source: string }> }> = {};

      for (const role of builtInRoles) {
        const toolKey = `${role}:${toolId}`;
        const defaultEnabled = TOOL_DEFAULT_PERMISSIONS[toolId][role];
        const overrideEnabled = toolOverrides.get(toolKey);
        const effectiveEnabled = overrideEnabled ?? defaultEnabled;

        const actions: Record<string, { enabled: boolean; source: string }> = {};
        for (const action of TOOL_SUPPORTED_ACTIONS[toolId]) {
          const actionKey = `${role}:${toolId}:${action}`;
          const actionOverride = actionOverrides.get(actionKey);
          actions[action] = {
            enabled: actionOverride ?? effectiveEnabled,
            source: actionOverride !== undefined ? 'override' : 'default',
          };
        }

        roles[role] = {
          enabled: effectiveEnabled,
          source: overrideEnabled !== undefined ? 'override' : 'default',
          actions,
        };
      }

      return { toolId, roles };
    });

    res.json({ companyId, matrix });
  });

  // ── PUT /companies/:companyId/tools/:toolId ─────────────────────────────
  // Enable or disable a tool for a company role. Invalidates company cache.
  router.put('/companies/:companyId/tools/:toolId', async (req: Request, res: Response) => {
    const { companyId, toolId } = req.params as { companyId: string; toolId: string };

    if (!CANONICAL_TOOL_IDS.includes(toolId as any)) {
      badRequest(res, `Unknown toolId: ${toolId}`);
      return;
    }
    if (isFixedToolPolicy(toolId)) {
      badRequest(res, `Fixed-policy toolId cannot be configured: ${toolId}`);
      return;
    }

    const parsed = SetToolPermSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.message);
      return;
    }
    const { role, enabled, updatedBy } = parsed.data;

    const result = await deps.toolPermRepo.upsert(companyId, toolId, role, enabled, updatedBy);
    if (!result.ok) {
      log.error('admin.tool_perm.upsert_failed', { companyId, toolId, role });
      res.status(500).json({ error: 'internal_error', message: 'Failed to update permission' });
      return;
    }

    await deps.permissions.invalidateCompany(companyId);
    auditService.record({
      actorId:   actorId(req),
      companyId,
      action:    'permission.set_company_tool',
      outcome:   'success',
      metadata:  { toolId, role, enabled },
    });
    log.info('admin.tool_perm.updated', { companyId, toolId, role, enabled });
    res.json({ ok: true, companyId, toolId, role, enabled });
  });

  // ── PUT /companies/:companyId/tools/:toolId/actions/:actionGroup ────────
  // Enable or disable a specific action for a company role+tool. Invalidates company cache.
  router.put('/companies/:companyId/tools/:toolId/actions/:actionGroup', async (req: Request, res: Response) => {
    const { companyId, toolId, actionGroup } = req.params as {
      companyId: string; toolId: string; actionGroup: string;
    };

    if (!CANONICAL_TOOL_IDS.includes(toolId as any)) {
      badRequest(res, `Unknown toolId: ${toolId}`);
      return;
    }
    const supportedActions = TOOL_SUPPORTED_ACTIONS[toolId as keyof typeof TOOL_SUPPORTED_ACTIONS];
    if (!supportedActions.includes(actionGroup)) {
      badRequest(res, `Action '${actionGroup}' not supported by tool '${toolId}'`);
      return;
    }

    const parsed = SetActionPermSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.message);
      return;
    }
    const { role, enabled, updatedBy } = parsed.data;

    const write = await deps.permissionWrites.setCompanyAction({
      companyId, actorId: actorId(req), ...(updatedBy ? { updatedBy } : {}), toolId, role, actionGroup, enabled,
    });
    if (!write.ok) {
      res.status(write.reason === 'invalid' ? 400 : 500).json({ error: write.reason === 'invalid' ? 'bad_request' : 'internal_error', message: 'Failed to update action permission' });
      return;
    }
    res.json({ ok: true, companyId, toolId, actionGroup, role, enabled });
  });

  // ── GET /companies/:companyId/departments/:deptId/matrix ────────────────
  // Returns dept-role tool+action permissions for the given department.
  // Pass ?roleId=<roleId> to filter by dept role. Without it, returns all.
  router.get('/companies/:companyId/departments/:deptId/matrix', async (req: Request, res: Response) => {
    const { companyId, deptId } = req.params as { companyId: string; deptId: string };
    const { roleId } = req.query as { roleId?: string };

    if (!roleId) {
      badRequest(res, 'Query param ?roleId is required');
      return;
    }

    const result = await deps.deptToolPermRepo.getForDeptRole(deptId, roleId);
    if (!result.ok) {
      log.error('admin.dept_matrix.db_error', { deptId, roleId });
      res.status(500).json({ error: 'internal_error', message: 'Failed to load dept permissions' });
      return;
    }

    res.json({ companyId, deptId, roleId, permissions: result.value });
  });

  // ── PUT /companies/:companyId/departments/:deptId/tools/:toolId/actions/:actionGroup
  // Set a dept-role's permission for a specific tool+action. Invalidates dept cache.
  router.put(
    '/companies/:companyId/departments/:deptId/tools/:toolId/actions/:actionGroup',
    async (req: Request, res: Response) => {
      const { companyId, deptId, toolId, actionGroup } = req.params as {
        companyId: string; deptId: string; toolId: string; actionGroup: string;
      };

      if (!CANONICAL_TOOL_IDS.includes(toolId as any)) {
        badRequest(res, `Unknown toolId: ${toolId}`);
        return;
      }
      const supportedActions = TOOL_SUPPORTED_ACTIONS[toolId as keyof typeof TOOL_SUPPORTED_ACTIONS];
      if (!supportedActions.includes(actionGroup)) {
        badRequest(res, `Action '${actionGroup}' not supported by tool '${toolId}'`);
        return;
      }

      const parsed = SetDeptPermSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error.message);
        return;
      }
      const { roleId, allowed, updatedBy } = parsed.data;

      const write = await deps.permissionWrites.setDepartmentRoleAction({
        companyId, departmentId: deptId, actorId: actorId(req), updatedBy, toolId, roleId, actionGroup, allowed,
      });
      if (!write.ok) {
        res.status(write.reason === 'invalid' ? 400 : 500).json({ error: write.reason === 'invalid' ? 'bad_request' : 'internal_error', message: 'Failed to update dept permission' });
        return;
      }
      res.json({ ok: true, companyId, deptId, roleId, toolId, actionGroup, allowed });
    },
  );

  // ── POST /companies/:companyId/cache/invalidate ─────────────────────────
  router.post('/companies/:companyId/cache/invalidate', async (req: Request, res: Response) => {
    const { companyId } = req.params as { companyId: string };
    await deps.permissions.invalidateCompany(companyId);
    log.info('admin.cache.invalidated.company', { companyId });
    res.json({ ok: true, companyId, scope: 'company' });
  });

  // ── POST /companies/:companyId/departments/:deptId/cache/invalidate ─────
  router.post('/companies/:companyId/departments/:deptId/cache/invalidate', async (req: Request, res: Response) => {
    const { companyId, deptId } = req.params as { companyId: string; deptId: string };
    await deps.permissions.invalidateDept(companyId, deptId);
    log.info('admin.cache.invalidated.dept', { companyId, deptId });
    res.json({ ok: true, companyId, deptId, scope: 'department' });
  });

  return router;
};
