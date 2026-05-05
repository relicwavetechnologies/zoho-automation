/**
 * Audit log routes.
 *
 * Mounted at /api/admin/audit.
 *
 *   GET /logs  — query audit logs for a company (newest first)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuditService } from '../../application/observability/audit.service';
import type { Logger } from '../../shared/logger';

export interface AuditRoutesDeps {
  auditService: AuditService;
  logger:       Logger;
}

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

export function createAuditRoutes(deps: AuditRoutesDeps): Router {
  const router = Router();

  router.get('/logs', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const rawLimit  = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const limit     = Number.isFinite(rawLimit) ? Math.min(rawLimit, 500) : 100;
    const actorId   = typeof req.query.actorId === 'string' ? req.query.actorId : undefined;
    const action    = typeof req.query.action  === 'string' ? req.query.action  : undefined;

    const logs = await deps.auditService.query({
      companyId,
      limit,
      ...(actorId ? { actorId } : {}),
      ...(action  ? { action  } : {}),
    });
    success(res, logs, 'Audit logs loaded');
  }));

  return router;
}
