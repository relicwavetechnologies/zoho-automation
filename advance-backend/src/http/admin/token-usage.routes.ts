/**
 * Admin token usage routes — per-member consumption and limits.
 *
 * Mounted at /api/admin/token-usage.
 *
 *   GET  /summary           — aggregated token stats + per-user + per-model breakdown
 *   GET  /members            — per-member usage with monthly limits
 *   PUT  /members/:userId/limit — update monthly token limit for a user
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

export interface TokenUsageRoutesDeps {
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

export function createTokenUsageRoutes(deps: TokenUsageRoutesDeps): Router {
  const router = Router();
  const { prisma, logger } = deps;

  // ─── GET /summary ───────────────────────────────────────────────────
  router.get('/summary', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const daysRaw   = typeof req.query.days === 'string' ? Number(req.query.days) : 30;
    const days      = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 30;

    const now  = new Date();
    const from = new Date(now.getTime() - days * 86_400_000);

    const [totals, byModel] = await Promise.all([
      prisma.aiTokenUsage.aggregate({
        where: { companyId, createdAt: { gte: from, lte: now } },
        _sum: { actualInputTokens: true, actualOutputTokens: true },
        _count: { id: true },
      }),
      prisma.aiTokenUsage.groupBy({
        by: ['modelId', 'provider'],
        where: { companyId, createdAt: { gte: from, lte: now } },
        _sum: { actualInputTokens: true, actualOutputTokens: true },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
    ]);

    const totalInput  = totals._sum.actualInputTokens ?? 0;
    const totalOutput = totals._sum.actualOutputTokens ?? 0;

    success(res, {
      period: { days, from: from.toISOString(), to: now.toISOString() },
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      callCount: totals._count.id,
      estimatedCostUsd: Math.round(
        (totalInput * 0.15 / 1_000_000 + totalOutput * 0.6 / 1_000_000) * 100,
      ) / 100,
      byModel: byModel.map(m => ({
        modelId: m.modelId,
        provider: m.provider,
        calls: m._count.id,
        inputTokens: m._sum.actualInputTokens ?? 0,
        outputTokens: m._sum.actualOutputTokens ?? 0,
      })),
    }, 'Token usage summary loaded');
  }));

  // ─── GET /members ───────────────────────────────────────────────────
  router.get('/members', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const daysRaw   = typeof req.query.days === 'string' ? Number(req.query.days) : 30;
    const days      = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 30;

    const now  = new Date();
    const from = new Date(now.getTime() - days * 86_400_000);

    const byUser = await prisma.aiTokenUsage.groupBy({
      by: ['userId'],
      where: { companyId, createdAt: { gte: from, lte: now } },
      _sum: { actualInputTokens: true, actualOutputTokens: true },
      _count: { id: true },
      orderBy: { _sum: { actualOutputTokens: 'desc' } },
    });

    const userIds = byUser.map(u => u.userId);

    const [users, policies] = await Promise.all([
      userIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true },
          })
        : [],
      userIds.length > 0
        ? prisma.memberTokenPolicy.findMany({
            where: { userId: { in: userIds } },
          })
        : [],
    ]);

    const userMap   = new Map(users.map(u => [u.id, u]));
    const policyMap = new Map(policies.map(p => [p.userId, p]));

    const members = byUser.map(u => {
      const user   = userMap.get(u.userId);
      const policy = policyMap.get(u.userId);
      const input  = u._sum.actualInputTokens ?? 0;
      const output = u._sum.actualOutputTokens ?? 0;
      const total  = input + output;
      const limit  = policy?.monthlyTokenLimit ?? 2_000_000;

      return {
        userId:       u.userId,
        name:         user?.name ?? null,
        email:        user?.email ?? null,
        inputTokens:  input,
        outputTokens: output,
        totalTokens:  total,
        calls:        u._count.id,
        monthlyLimit: limit,
        usagePct:     limit > 0 ? Math.round((total / limit) * 1000) / 10 : 0,
      };
    });

    success(res, { period: { days }, members }, 'Member token usage loaded');
  }));

  // ─── PUT /members/:userId/limit ─────────────────────────────────────
  router.put('/members/:userId/limit', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const userId = req.params.userId;
    if (!userId) throw routeError(400, 'userId is required');
    const body = z.object({ monthlyTokenLimit: z.number().int().min(0).max(100_000_000) }).parse(req.body);

    await prisma.memberTokenPolicy.upsert({
      where: { userId: userId },
      create: {
        userId: userId,
        companyId,
        monthlyTokenLimit: body.monthlyTokenLimit,
      },
      update: {
        monthlyTokenLimit: body.monthlyTokenLimit,
      },
    });

    logger.info('token_usage.limit.updated', { userId, companyId, limit: body.monthlyTokenLimit });
    success(res, { userId, monthlyTokenLimit: body.monthlyTokenLimit }, 'Token limit updated');
  }));

  return router;
}
