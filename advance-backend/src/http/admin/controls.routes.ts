/**
 * Admin controls routes.
 *
 * Mounted at /api/admin/controls.
 *
 *   GET  /  — list admin control states (optionally scoped to a company)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface ControlsRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
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

function resolveCompanyId(res: Response, providedId?: string): string | undefined {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  if (isSuperAdmin) return providedId;
  const localId = (res.locals['companyId'] as string | undefined) ?? '';
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId || undefined;
}

export function createControlsRoutes(deps: ControlsRoutesDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);

    const rows = await deps.prisma.adminControlState.findMany({
      where:   companyId ? { companyId } : {},
      orderBy: { updatedAt: 'desc' },
      take:    200,
    });

    const controls = rows.map(r => ({
      id:         r.id,
      controlKey: r.controlKey,
      companyId:  r.companyId,
      value:      r.value,
      updatedBy:  r.updatedBy,
      updatedAt:  r.updatedAt.toISOString(),
    }));
    success(res, controls, 'Admin controls loaded');
  }));

  return router;
}
