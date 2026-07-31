/**
 * Web Search admin observability.
 *
 * Mounted at /api/admin/web-search. This exposes connection metadata and
 * Divo-observed usage only; raw and encrypted Serper API keys never leave the
 * server. Company admins are limited to their company, while super admins can
 * view all companies or optionally one requested company.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import { deriveSerperConnectionUsage } from '../../infrastructure/persistence/company-serper-connection.repository';

export interface WebSearchAdminRoutesDeps {
  prisma: PrismaClient;
}

type RouteError = Error & { status: number };

const routeError = (status: number, message: string): RouteError => {
  const error = new Error(message) as RouteError;
  error.status = status;
  return error;
};

const success = <T>(res: Response, data: T, message?: string) =>
  res.status(200).json({ success: true, data, ...(message ? { message } : {}) });

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

const querySchema = z.object({
  companyId: z.string().uuid().optional(),
});

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function createWebSearchAdminRoutes(deps: WebSearchAdminRoutesDeps): Router {
  const router = Router();

  router.get('/connections', asyncRoute(async (req, res) => {
    const query = querySchema.parse(req.query);
    const sessionCompanyId = (res.locals['companyId'] as string | undefined) ?? '';
    const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);

    if (!isSuperAdmin && query.companyId && query.companyId !== sessionCompanyId) {
      throw routeError(403, 'Cannot view web search connections for another company');
    }
    if (!isSuperAdmin && !sessionCompanyId) {
      throw routeError(403, 'Company context is required');
    }

    const companyId = isSuperAdmin ? query.companyId : sessionCompanyId;
    const rows = await deps.prisma.companySerperConnection.findMany({
      where: { revokedAt: null, ...(companyId ? { companyId } : {}) },
      select: {
        id: true,
        companyId: true,
        label: true,
        status: true,
        priority: true,
        lastTestedAt: true,
        lastSucceededAt: true,
        lastFailureAt: true,
        lastFailureCode: true,
        lastUsedAt: true,
        successfulRequestCount: true,
        creditsAtLastSync: true,
        usageAtLastCreditSync: true,
        creditsSyncedAt: true,
        unavailableUntil: true,
        createdAt: true,
        updatedAt: true,
        company: { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ companyId: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    });

    const now = new Date();
    const connections = rows.map((row) => {
      const usage = deriveSerperConnectionUsage(row);
      const inCooldown = Boolean(row.unavailableUntil && row.unavailableUntil > now);
      const health = row.status === 'disabled'
        ? 'disabled'
        : inCooldown
          ? 'cooling_down'
          : usage.estimatedCreditsRemaining === 0
            ? 'estimated_depleted'
            : row.status === 'connected'
              ? 'available'
              : 'unavailable';
      return {
        id: row.id,
        company: row.company,
        label: row.label,
        status: row.status,
        health,
        priority: row.priority,
        addedBy: row.createdByUser
          ? { id: row.createdByUser.id, name: row.createdByUser.name, email: row.createdByUser.email }
          : null,
        addedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastTestedAt: iso(row.lastTestedAt),
        lastSucceededAt: iso(row.lastSucceededAt),
        lastFailureAt: iso(row.lastFailureAt),
        lastFailureCode: row.lastFailureCode,
        lastUsedAt: iso(row.lastUsedAt),
        unavailableUntil: iso(row.unavailableUntil),
        successfulRequestCount: row.successfulRequestCount,
        observedRequestsSinceCreditSync: usage.observedRequestsSinceCreditSync,
        creditsAtLastSync: row.creditsAtLastSync,
        creditsSyncedAt: iso(row.creditsSyncedAt),
        estimatedCreditsRemaining: usage.estimatedCreditsRemaining ?? null,
      };
    });

    const summary = {
      companyCount: new Set(connections.map(connection => connection.company.id)).size,
      connectionCount: connections.length,
      availableConnectionCount: connections.filter(connection => connection.health === 'available').length,
      observedSearches: connections.reduce((total, connection) => total + connection.successfulRequestCount, 0),
      balanceTrackedConnectionCount: connections.filter(connection => connection.creditsAtLastSync !== null).length,
    };

    success(res, { scope: { companyId: companyId ?? null, isSuperAdmin }, summary, connections }, 'Web search connections loaded');
  }));

  return router;
}
