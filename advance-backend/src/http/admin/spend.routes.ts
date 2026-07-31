/**
 * Admin spend routes — real cost/spend aggregations for the observability UI.
 *
 * Mounted at /api/admin/spend.
 *
 *   GET /company-daily?days=14   — today totals + daily spend series + cache rate
 *   GET /by-model?days=30        — per-model cost + cache-split token breakdown
 *   GET /members?days=30         — per-member spend (today + window) + limits + totals
 *   GET /members/:userId?days=30 — one member: spend, avg, sparkline, cost-by-model
 *
 * Cost is priced from exact cache-split token counts via pricing.ts (Track B) —
 * NOT the provider-reported `reportedCostUsd`. Every endpoint groups by model so
 * per-model rates apply, then sums. Tokens/runs are exact.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { costUsd } from '../../application/observability/pricing';

export interface SpendRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
}

type RouteError = Error & { status: number };
const routeError = (status: number, message: string): RouteError => {
  const e = new Error(message) as RouteError;
  e.status = status;
  return e;
};
const success = <T>(res: Response, data: T) => res.status(200).json({ success: true, data });
const fail = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });

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
  const localId = (res.locals['companyId'] as string | undefined) ?? '';
  if (isSuperAdmin) {
    if (!providedId) throw routeError(400, 'companyId is required for super-admin requests');
    return providedId;
  }
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId;
}

const qDays = (req: Request, def: number, max: number): number => {
  const raw = typeof req.query.days === 'string' ? Number(req.query.days) : def;
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, max) : def;
};
const qCompany = (req: Request, res: Response) =>
  resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
const qChannel = (req: Request): string | undefined => {
  const value = typeof req.query.channel === 'string' ? req.query.channel : undefined;
  return value && ['desktop', 'lark', 'web'].includes(value) ? value : undefined;
};
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };

// ─── Pricing helpers ────────────────────────────────────────────────────────
type TokenSum = { actualInputTokens: number | null; cacheReadInputTokens: number | null; actualOutputTokens: number | null };
const priceSum = (modelId: string, s: TokenSum | undefined): number =>
  costUsd(modelId, {
    cacheMissIn: s?.actualInputTokens ?? 0,
    cacheHitIn: s?.cacheReadInputTokens ?? 0,
    output: s?.actualOutputTokens ?? 0,
  });

type DailyModelRow = { day: Date; model: string; miss: number; hit: number; out: number };
function costByDay(rows: DailyModelRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    const c = costUsd(r.model, { cacheMissIn: Number(r.miss), cacheHitIn: Number(r.hit), output: Number(r.out) });
    m.set(key, (m.get(key) ?? 0) + c);
  }
  return m;
}
function fillSeries(byDay: Map<string, number>, days: number): { date: string; spendUsd: number }[] {
  const out: { date: string; spendUsd: number }[] = [];
  const today = startOfToday();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: key, spendUsd: byDay.get(key) ?? 0 });
  }
  return out;
}

export function createSpendRoutes(deps: SpendRoutesDeps): Router {
  const router = Router();
  const { prisma } = deps;

  // ─── GET /company-daily ─────────────────────────────────────────────
  router.get('/company-daily', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const channel = qChannel(req);
    const days = qDays(req, 14, 90);
    const now = new Date();
    const from = new Date(now.getTime() - days * 86_400_000);
    const today = startOfToday();

    const [todayByModel, windowAgg, runsToday, dailyRows] = await Promise.all([
      prisma.aiTokenUsage.groupBy({
        by: ['modelId'],
        where: { companyId, createdAt: { gte: today }, ...(channel ? { channel } : {}) },
        _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        orderBy: { modelId: 'asc' },
      }),
      prisma.aiTokenUsage.aggregate({
        where: { companyId, createdAt: { gte: from }, ...(channel ? { channel } : {}) },
        _sum: { actualInputTokens: true, cacheReadInputTokens: true },
      }),
      prisma.executionRun.count({ where: { companyId, startedAt: { gte: today }, ...(channel ? { channel } : {}) } }),
      prisma.$queryRaw<DailyModelRow[]>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, "modelId" AS model,
          COALESCE(SUM("actualInputTokens"), 0)::float AS miss,
          COALESCE(SUM("cacheReadInputTokens"), 0)::float AS hit,
          COALESCE(SUM("actualOutputTokens"), 0)::float AS out
        FROM "AiTokenUsage"
        WHERE "companyId" = ${companyId} AND "createdAt" >= ${from}
          ${channel ? Prisma.sql`AND "channel" = ${channel}` : Prisma.empty}
        GROUP BY day, model ORDER BY day ASC`),
    ]);

    const spendToday = todayByModel.reduce((sum, m) => sum + priceSum(m.modelId, m._sum), 0);
    const miss = windowAgg._sum.actualInputTokens ?? 0;
    const hit = windowAgg._sum.cacheReadInputTokens ?? 0;
    const cacheSavingsPct = miss + hit > 0 ? Math.round((hit / (miss + hit)) * 100) : 0;

    success(res, {
      today: { spendUsd: spendToday, runs: runsToday },
      series: fillSeries(costByDay(dailyRows), days),
      cacheSavingsPct,
    });
  }));

  // ─── GET /by-model ──────────────────────────────────────────────────
  router.get('/by-model', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const channel = qChannel(req);
    const days = qDays(req, 30, 90);
    const from = new Date(Date.now() - days * 86_400_000);

    const byModel = await prisma.aiTokenUsage.groupBy({
      by: ['modelId', 'provider'],
      where: { companyId, createdAt: { gte: from }, ...(channel ? { channel } : {}) },
      _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
      _count: { id: true },
      orderBy: { modelId: 'asc' },
    });

    const rows = byModel
      .map(m => ({
        modelId: m.modelId,
        provider: m.provider,
        calls: m._count.id,
        cacheMissIn: m._sum.actualInputTokens ?? 0,
        cacheHitIn: m._sum.cacheReadInputTokens ?? 0,
        output: m._sum.actualOutputTokens ?? 0,
        costUsd: priceSum(m.modelId, m._sum),
      }))
      .sort((a, b) => b.costUsd - a.costUsd);

    success(res, rows);
  }));

  // ─── GET /members ───────────────────────────────────────────────────
  router.get('/members', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const channel = qChannel(req);
    const days = qDays(req, 30, 90);
    const from = new Date(Date.now() - days * 86_400_000);
    const today = startOfToday();

    const [windowRows, todayRows, runsByUser] = await Promise.all([
      prisma.aiTokenUsage.groupBy({
        by: ['userId', 'modelId'],
        where: { companyId, createdAt: { gte: from }, ...(channel ? { channel } : {}) },
        _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        orderBy: { userId: 'asc' },
      }),
      prisma.aiTokenUsage.groupBy({
        by: ['userId', 'modelId'],
        where: { companyId, createdAt: { gte: today }, ...(channel ? { channel } : {}) },
        _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        orderBy: { userId: 'asc' },
      }),
      prisma.executionRun.groupBy({
        by: ['userId'],
        where: { companyId, startedAt: { gte: from }, userId: { not: null }, ...(channel ? { channel } : {}) },
        _count: { id: true },
        orderBy: { userId: 'asc' },
      }),
    ]);

    // Fold per-(user,model) rows → per-user spend + tokens.
    const spend30d = new Map<string, number>();
    const tokens = new Map<string, number>();
    for (const r of windowRows) {
      spend30d.set(r.userId, (spend30d.get(r.userId) ?? 0) + priceSum(r.modelId, r._sum));
      tokens.set(r.userId, (tokens.get(r.userId) ?? 0) + (r._sum.actualInputTokens ?? 0) + (r._sum.actualOutputTokens ?? 0));
    }
    const spendToday = new Map<string, number>();
    for (const r of todayRows) spendToday.set(r.userId, (spendToday.get(r.userId) ?? 0) + priceSum(r.modelId, r._sum));

    const userIds = [...spend30d.keys()];
    const [users, policies] = await Promise.all([
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
      userIds.length ? prisma.memberTokenPolicy.findMany({ where: { userId: { in: userIds } } }) : [],
    ]);
    const userMap = new Map(users.map(u => [u.id, u]));
    const policyMap = new Map(policies.map(p => [p.userId, p]));
    const runsMap = new Map(runsByUser.map(r => [r.userId as string, r._count.id]));

    const members = userIds
      .map(uid => {
        const user = userMap.get(uid);
        const tok = tokens.get(uid) ?? 0;
        const limit = policyMap.get(uid)?.monthlyTokenLimit ?? 2_000_000;
        return {
          userId: uid,
          name: user?.name ?? null,
          email: user?.email ?? null,
          tokens: tok,
          spend30d: spend30d.get(uid) ?? 0,
          spendToday: spendToday.get(uid) ?? 0,
          runs: runsMap.get(uid) ?? 0,
          monthlyLimit: limit,
          usagePct: limit > 0 ? Math.round((tok / limit) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.spend30d - a.spend30d);

    const spend30dTotal = members.reduce((s, m) => s + m.spend30d, 0);
    const top = members[0] ?? null;
    const over = members.filter(m => m.usagePct >= 85);

    success(res, {
      members,
      totals: {
        memberCount: members.length,
        spend30d: spend30dTotal,
        topSpender: top ? { name: top.name ?? top.email ?? '—', amount: top.spend30d } : null,
        overLimit: { count: over.length, name: over[0]?.name ?? over[0]?.email ?? null, pct: over[0]?.usagePct ?? null },
      },
    });
  }));

  // ─── GET /members/:userId ───────────────────────────────────────────
  router.get('/members/:userId', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const channel = qChannel(req);
    const userId = req.params.userId;
    if (!userId) throw routeError(400, 'userId is required');
    const days = qDays(req, 30, 90);
    const from = new Date(Date.now() - days * 86_400_000);
    const today = startOfToday();
    const sparkFrom = new Date(Date.now() - 14 * 86_400_000);

    const [byModel, todayByModel, mtdByModel, runs, user, policy, sparkRows] = await Promise.all([
      prisma.aiTokenUsage.groupBy({
        by: ['modelId'],
        where: { companyId, userId, createdAt: { gte: from }, ...(channel ? { channel } : {}) },
        _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        _count: { id: true },
        orderBy: { modelId: 'asc' },
      }),
      prisma.aiTokenUsage.groupBy({
        by: ['modelId'],
        where: { companyId, userId, createdAt: { gte: today }, ...(channel ? { channel } : {}) },
        _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        orderBy: { modelId: 'asc' },
      }),
      // Calendar month-to-date — matches the proxy gate's budget window exactly.
      prisma.aiTokenUsage.groupBy({
        by: ['modelId'],
        where: { companyId, userId, createdAt: { gte: startOfMonth() }, ...(channel ? { channel } : {}) },
        _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        orderBy: { modelId: 'asc' },
      }),
      prisma.executionRun.count({ where: { companyId, userId, startedAt: { gte: from }, ...(channel ? { channel } : {}) } }),
      prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
      prisma.memberTokenPolicy.findUnique({ where: { userId } }),
      prisma.$queryRaw<DailyModelRow[]>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, "modelId" AS model,
          COALESCE(SUM("actualInputTokens"), 0)::float AS miss,
          COALESCE(SUM("cacheReadInputTokens"), 0)::float AS hit,
          COALESCE(SUM("actualOutputTokens"), 0)::float AS out
        FROM "AiTokenUsage"
        WHERE "companyId" = ${companyId} AND "userId" = ${userId} AND "createdAt" >= ${sparkFrom}
          ${channel ? Prisma.sql`AND "channel" = ${channel}` : Prisma.empty}
        GROUP BY day, model ORDER BY day ASC`),
    ]);

    const spend30d = byModel.reduce((s, m) => s + priceSum(m.modelId, m._sum), 0);
    const tokens = byModel.reduce((s, m) => s + (m._sum.actualInputTokens ?? 0) + (m._sum.actualOutputTokens ?? 0), 0);
    const spendToday = todayByModel.reduce((s, m) => s + priceSum(m.modelId, m._sum), 0);
    const spendMtd = mtdByModel.reduce((s, m) => s + priceSum(m.modelId, m._sum), 0);
    const limit = policy?.monthlyTokenLimit ?? 2_000_000;

    const series = fillSeries(costByDay(sparkRows), 14).map(s => s.spendUsd);
    const max = Math.max(...series, 0);
    const sparkline = series.map(c => (max > 0 ? Math.max(6, Math.round((c / max) * 100)) : 6));

    success(res, {
      userId,
      name: user?.name ?? null,
      email: user?.email ?? null,
      spendToday,
      spend30d,
      spendMtd,
      avgPerRun: runs > 0 ? spend30d / runs : 0,
      tokens,
      runs,
      monthlyLimit: limit,
      usagePct: limit > 0 ? Math.round((tokens / limit) * 1000) / 10 : 0,
      sparkline,
      costByModel: byModel
        .map(m => ({ modelId: m.modelId, runs: m._count.id, costUsd: priceSum(m.modelId, m._sum) }))
        .sort((a, b) => b.costUsd - a.costUsd),
    });
  }));

  return router;
}
