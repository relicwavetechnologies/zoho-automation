/**
 * RBAC permission routes.
 *
 * Mounted at /api/admin/rbac.
 *
 *   GET /permissions  — list permission matrix (role → action → allowed)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface RbacRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
}

type RouteError = Error & { status: number };

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

export function createRbacRoutes(deps: RbacRoutesDeps): Router {
  const router = Router();

  router.get('/permissions', asyncRoute(async (_req, res) => {
    const rows = await deps.prisma.rbacPermission.findMany({
      orderBy: [{ role: 'asc' }, { action: 'asc' }],
    });
    const permissions = rows.map(r => ({
      id:        r.id,
      role:      r.role,
      action:    r.action,
      allowed:   r.allowed,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
    }));
    success(res, permissions, 'Permission matrix loaded');
  }));

  return router;
}
