/**
 * Admin analytics routes — dashboard aggregations.
 *
 * Mounted at /api/admin/analytics.
 *
 *   GET /overview  — aggregated dashboard stats (executions, cost, channels, users, trends)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface AnalyticsRoutesDeps {
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

export function createAnalyticsRoutes(deps: AnalyticsRoutesDeps): Router {
  const router = Router();
  const { prisma, logger } = deps;

  router.get('/overview', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const daysRaw   = typeof req.query.days === 'string' ? Number(req.query.days) : 30;
    const days      = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 30;

    const now   = new Date();
    const from  = new Date(now.getTime() - days * 86_400_000);
    const prevFrom = new Date(from.getTime() - days * 86_400_000);

    // Run all queries in parallel
    const [
      executions,
      prevExecutions,
      successCount,
      channelBreakdown,
      activeMemberCount,
      departmentCount,
      tokenUsage,
      userActivity,
      weeklyTrend,
      integrationStatus,
      modelBreakdown,
    ] = await Promise.all([
      // Total executions in period
      prisma.executionRun.count({
        where: { companyId, startedAt: { gte: from, lte: now } },
      }),

      // Previous period executions (for growth %)
      prisma.executionRun.count({
        where: { companyId, startedAt: { gte: prevFrom, lt: from } },
      }),

      // Successful executions
      prisma.executionRun.count({
        where: { companyId, startedAt: { gte: from, lte: now }, status: 'completed' },
      }),

      // Channel breakdown
      prisma.executionRun.groupBy({
        by: ['channel'],
        where: { companyId, startedAt: { gte: from, lte: now } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),

      // Active members (distinct users with executions)
      prisma.executionRun.findMany({
        where: { companyId, startedAt: { gte: from, lte: now }, userId: { not: null } },
        select: { userId: true },
        distinct: ['userId'],
      }).then(rows => rows.length),

      // Department count
      prisma.department.count({
        where: { companyId, status: 'active' },
      }),

      // Token usage totals
      prisma.aiTokenUsage.aggregate({
        where: { companyId, createdAt: { gte: from, lte: now } },
        _sum: { actualInputTokens: true, actualOutputTokens: true },
        _count: { id: true },
      }),

      // Top users by execution count
      prisma.executionRun.groupBy({
        by: ['userId'],
        where: { companyId, startedAt: { gte: from, lte: now }, userId: { not: null } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),

      // Weekly trend (last 7 weeks)
      prisma.$queryRaw<Array<{ week: string; count: bigint }>>`
        SELECT to_char(date_trunc('week', "startedAt"), 'YYYY-MM-DD') AS week,
               COUNT(*)::bigint AS count
        FROM "ExecutionRun"
        WHERE "companyId" = ${companyId}
          AND "startedAt" >= ${new Date(now.getTime() - 49 * 86_400_000)}
          AND "startedAt" <= ${now}
        GROUP BY date_trunc('week', "startedAt")
        ORDER BY week ASC
      `,

      // Integration connection status (use Prisma count to avoid raw table name issues)
      Promise.all([
        prisma.zohoConnection.count({ where: { companyId, status: 'CONNECTED' } }),
        prisma.larkTenantBinding.count({ where: { companyId, isActive: true } }),
        prisma.integrationConnection.count({ where: { companyId, provider: 'google_workspace', revokedAt: null } }),
      ]).then(([zoho, lark, google]) => [
        { provider: 'zoho', connected: zoho > 0 },
        { provider: 'lark', connected: lark > 0 },
        { provider: 'google', connected: google > 0 },
      ] as Array<{ provider: string; connected: boolean }>),

      // Token usage by model
      prisma.aiTokenUsage.groupBy({
        by: ['modelId', 'provider'],
        where: { companyId, createdAt: { gte: from, lte: now } },
        _sum: { actualInputTokens: true, actualOutputTokens: true },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
    ]);

    // Resolve user names for activity
    const userIds = userActivity.map(u => u.userId).filter((id): id is string => id !== null);
    const users = userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    // Compute derived stats
    const totalInputTokens  = tokenUsage._sum.actualInputTokens ?? 0;
    const totalOutputTokens = tokenUsage._sum.actualOutputTokens ?? 0;
    const totalTokens       = totalInputTokens + totalOutputTokens;
    const growthPct         = prevExecutions > 0
      ? Math.round(((executions - prevExecutions) / prevExecutions) * 1000) / 10
      : null;
    const successRate = executions > 0
      ? Math.round((successCount / executions) * 1000) / 10
      : 0;

    // Rough cost estimate (blended rate)
    const estimatedCostUsd = Math.round(
      (totalInputTokens * 0.15 / 1_000_000 + totalOutputTokens * 0.6 / 1_000_000) * 100,
    ) / 100;

    success(res, {
      period: { days, from: from.toISOString(), to: now.toISOString() },
      executions: {
        total: executions,
        previousTotal: prevExecutions,
        growthPct,
        delta: executions - prevExecutions,
      },
      successRate,
      activeMembers: activeMemberCount,
      departmentCount,
      tokens: {
        totalInput: totalInputTokens,
        totalOutput: totalOutputTokens,
        total: totalTokens,
        callCount: tokenUsage._count.id,
        estimatedCostUsd,
      },
      channelBreakdown: channelBreakdown.map(c => ({
        channel: c.channel,
        count: c._count.id,
        pct: executions > 0 ? Math.round((c._count.id / executions) * 1000) / 10 : 0,
      })),
      userActivity: userActivity.map(u => {
        const user = userMap.get(u.userId!);
        return {
          userId: u.userId,
          name: user?.name ?? user?.email ?? u.userId,
          email: user?.email ?? null,
          count: u._count.id,
          pct: executions > 0 ? Math.round((u._count.id / executions) * 1000) / 10 : 0,
        };
      }),
      weeklyTrend: weeklyTrend.map(w => ({
        week: w.week,
        count: Number(w.count),
      })),
      integrations: integrationStatus,
      modelBreakdown: modelBreakdown.map(m => ({
        modelId: m.modelId,
        provider: m.provider,
        calls: m._count.id,
        inputTokens: m._sum.actualInputTokens ?? 0,
        outputTokens: m._sum.actualOutputTokens ?? 0,
      })),
    }, 'Analytics overview loaded');
  }));

  return router;
}
