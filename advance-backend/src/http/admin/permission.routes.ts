import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ToolPermissionRepoPort } from '../../infrastructure/persistence/tool-permission.repository';
import type { PermissionService } from '../../application/permissions/permission.service';
import type { Logger } from '../../shared/logger';
import type { AuditService } from '../../application/observability/audit.service';
import { isFixedToolPolicy } from '../../domain/tools/tool-policy';
import { CANONICAL_TOOL_IDS } from '../../domain/tools/tool-id';

export interface AdminPermissionRouteDeps {
  toolPermRepo: ToolPermissionRepoPort;
  permissions: PermissionService;
  logger: Logger;
  auditService: AuditService;
}

// ── Request body schemas ───────────────────────────────────────────────────

const SetToolPermSchema = z.object({
  role:       z.string().min(1),
  enabled:    z.boolean(),
  updatedBy:  z.string().optional(),
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

  return router;
};
