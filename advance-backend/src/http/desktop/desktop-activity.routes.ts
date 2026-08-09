/**
 * A member's own usage and runs.
 *
 * Both existed only as admin views. The data was always keyed by userId — the
 * route simply refused to answer anyone but an admin, which meant a person
 * could not see what Divo had done on their behalf or what it cost them.
 *
 * Every query here is pinned to the signed-in user from `res.locals`, never
 * from a parameter. There is deliberately no way to ask this router about
 * somebody else: the admin surface already exists for that and enforces its own
 * authority, and a userId parameter here would be one missing check away from
 * letting any member read any colleague's activity.
 */
import { Router, type Request, type Response } from 'express';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';
import {
  costByDay, fillSeries, priceSum, startOfToday,
  type DailyModelRow,
} from '../../application/observability/token-cost';

export interface DesktopActivityRoutesDeps {
  prisma: PrismaClient;
  logger: Logger;
  memberJwtSecret: string;
}

/*
 * Sixteen weeks, because that is what a calendar of days is drawn over.
 *
 * Ninety was an arbitrary round number and it silently clamped the one caller
 * that asks for a full window — the Home usage card, whose heatmap is sixteen
 * columns of seven. Clamped to 90 it drew thirteen columns and a ragged
 * thirteenth, which reads as missing data rather than as a shorter window.
 *
 * The cost of the extra 22 days is one wider `WHERE createdAt >= …` on an
 * indexed column, plus the same again for the preceding window this route
 * already reads to report a change.
 */
const MAX_DAYS = 112;
const MAX_RUNS = 50;

const readDays = (req: Request, fallback: number): number => {
  const raw = typeof req.query['days'] === 'string' ? Number(req.query['days']) : fallback;
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : fallback;
};

export function createDesktopActivityRoutes(deps: DesktopActivityRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'desktop-activity' });
  const memberAuth = createMemberAuthMiddleware({
    prisma: deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger: deps.logger,
  });

  /**
   * GET /usage — what this person has spent, by day and by model.
   *
   * Priced through the shared cost helpers, so a member's total and the
   * admin's figure for that same member are the same arithmetic rather than
   * two implementations that agree until they do not.
   */
  router.get('/usage', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const days = readDays(req, 30);
      const from = new Date(Date.now() - days * 86_400_000);
      const today = startOfToday();
      const previousFrom = new Date(from.getTime() - days * 86_400_000);

      const [byModel, todayByModel, dailyRows, runs, previousRuns, windowAgg] = await Promise.all([
        deps.prisma.aiTokenUsage.groupBy({
          by: ['modelId'],
          where: { companyId, userId, createdAt: { gte: from } },
          _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
          _count: { id: true },
          orderBy: { modelId: 'asc' },
        }),
        deps.prisma.aiTokenUsage.groupBy({
          by: ['modelId'],
          where: { companyId, userId, createdAt: { gte: today } },
          _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
          orderBy: { modelId: 'asc' },
        }),
        deps.prisma.$queryRaw<DailyModelRow[]>(Prisma.sql`
          SELECT date_trunc('day', "createdAt") AS day, "modelId" AS model,
            COALESCE(SUM("actualInputTokens"), 0)::float AS miss,
            COALESCE(SUM("cacheReadInputTokens"), 0)::float AS hit,
            COALESCE(SUM("actualOutputTokens"), 0)::float AS out
          FROM "AiTokenUsage"
          WHERE "companyId" = ${companyId} AND "userId" = ${userId} AND "createdAt" >= ${from}
          GROUP BY day, model ORDER BY day ASC`),
        deps.prisma.executionRun.count({ where: { companyId, userId, startedAt: { gte: from } } }),
        // The equivalent window immediately before this one, so the UI can show
        // a change rather than a bare number nobody can interpret.
        deps.prisma.executionRun.count({
          where: { companyId, userId, startedAt: { gte: previousFrom, lt: from } },
        }),
        deps.prisma.aiTokenUsage.aggregate({
          where: { companyId, userId, createdAt: { gte: from } },
          _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
        }),
      ]);

      const spend = byModel.reduce((sum, m) => sum + priceSum(m.modelId, m._sum), 0);
      const spendToday = todayByModel.reduce((sum, m) => sum + priceSum(m.modelId, m._sum), 0);
      const miss = windowAgg._sum.actualInputTokens ?? 0;
      const hit = windowAgg._sum.cacheReadInputTokens ?? 0;

      res.json({
        success: true,
        data: {
          days,
          spendUsd: spend,
          spendTodayUsd: spendToday,
          runs,
          previousRuns,
          tokensIn: miss + hit,
          tokensOut: windowAgg._sum.actualOutputTokens ?? 0,
          // How much of the input was served from cache. Presented as a saving
          // because that is what it is — the same prompt priced far cheaper.
          cacheSavingsPct: miss + hit > 0 ? Math.round((hit / (miss + hit)) * 100) : 0,
          series: fillSeries(costByDay(dailyRows), days),
          byModel: byModel.map(m => ({
            modelId: m.modelId,
            calls: m._count.id,
            costUsd: priceSum(m.modelId, m._sum),
          })),
        },
      });
    } catch (e) {
      log.error('desktop.usage.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not read your usage.' });
    }
  });

  /**
   * GET /runs — what Divo has done for this person lately.
   *
   * Cost per run comes from AiTokenUsage rows carrying that run's id. Those
   * rows are nullable on the backend channel, so a run can legitimately show
   * zero cost; that is "nothing recorded against it", not "it was free", and
   * the client should not present it as a precise figure.
   */
  router.get('/runs', memberAuth, async (req: Request, res: Response) => {
    try {
      const userId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const rawLimit = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : 20;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_RUNS) : 20;

      const runs = await deps.prisma.executionRun.findMany({
        where: { companyId, userId },
        orderBy: { startedAt: 'desc' },
        take: limit,
        select: {
          id: true, channel: true, entrypoint: true, status: true,
          latestSummary: true, errorMessage: true,
          startedAt: true, finishedAt: true,
        },
      });

      const usage = runs.length
        ? await deps.prisma.aiTokenUsage.groupBy({
          by: ['executionRunId', 'modelId'],
          where: { companyId, userId, executionRunId: { in: runs.map(r => r.id) } },
          _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
          orderBy: { executionRunId: 'asc' },
        })
        : [];

      const costByRun = new Map<string, number>();
      for (const row of usage) {
        if (!row.executionRunId) continue;
        costByRun.set(row.executionRunId, (costByRun.get(row.executionRunId) ?? 0) + priceSum(row.modelId, row._sum));
      }

      res.json({
        success: true,
        data: {
          runs: runs.map(run => ({
            id: run.id,
            channel: run.channel,
            entrypoint: run.entrypoint,
            status: run.status,
            summary: run.latestSummary,
            errorMessage: run.errorMessage,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
            costUsd: costByRun.get(run.id) ?? 0,
          })),
        },
      });
    } catch (e) {
      log.error('desktop.runs.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not read your runs.' });
    }
  });

  return router;
}

const COMPANY_ADMIN_ROLES = new Set(['COMPANY_ADMIN', 'SUPER_ADMIN']);

/**
 * What one department cost, broken down by the people in it.
 *
 * This is the only genuinely net-new read in the manager scope. Usage is
 * indexed per person, and nothing joined it to a department — so a manager
 * could approve an action but never see what their team's work cost.
 *
 * The department is resolved to its members first, and every query is then
 * pinned to that member list. A manager therefore cannot see beyond their own
 * team even by naming another department: the authority check runs before the
 * member list is built, and the member list is the only thing the queries read.
 */
export function createDesktopTeamActivityRoutes(deps: DesktopActivityRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'desktop-team-activity' });
  const memberAuth = createMemberAuthMiddleware({
    prisma: deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger: deps.logger,
  });

  /** Its manager, or any company admin — the same rule the tool-access service uses. */
  const mayRead = async (userId: string, companyId: string, departmentId: string): Promise<boolean> => {
    const membership = await deps.prisma.adminMembership.findFirst({
      where: { userId, companyId, isActive: true },
      select: { role: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!membership) return false;
    if (COMPANY_ADMIN_ROLES.has(membership.role)) return true;
    const manages = await deps.prisma.departmentMembership.findFirst({
      where: {
        userId, departmentId, status: 'active',
        department: { companyId, status: 'active' },
        role: { slug: 'MANAGER' },
      },
      select: { id: true },
    });
    return Boolean(manages);
  };

  router.get('/departments/:departmentId/usage', memberAuth, async (req: Request, res: Response) => {
    try {
      const actorId = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const departmentId = req.params['departmentId'] as string;

      if (!await mayRead(actorId, companyId, departmentId)) {
        res.status(403).json({ success: false, message: 'You do not manage this team.' });
        return;
      }

      const days = readDays(req, 30);
      const from = new Date(Date.now() - days * 86_400_000);

      const memberships = await deps.prisma.departmentMembership.findMany({
        where: { departmentId, status: 'active', department: { companyId } },
        select: {
          userId: true,
          user: { select: { name: true, email: true } },
          role: { select: { slug: true, name: true } },
        },
      });
      const userIds = memberships.map(m => m.userId);

      if (userIds.length === 0) {
        res.json({
          success: true,
          data: { days, spendUsd: 0, runs: 0, totalPeople: 0, activePeople: 0, people: [] },
        });
        return;
      }

      const [byUserModel, runsByUser] = await Promise.all([
        deps.prisma.aiTokenUsage.groupBy({
          by: ['userId', 'modelId'],
          where: { companyId, userId: { in: userIds }, createdAt: { gte: from } },
          _sum: { actualInputTokens: true, cacheReadInputTokens: true, actualOutputTokens: true },
          orderBy: { userId: 'asc' },
        }),
        deps.prisma.executionRun.groupBy({
          by: ['userId'],
          where: { companyId, userId: { in: userIds }, startedAt: { gte: from } },
          _count: { id: true },
          orderBy: { userId: 'asc' },
        }),
      ]);

      const spendByUser = new Map<string, number>();
      for (const row of byUserModel) {
        if (!row.userId) continue;
        spendByUser.set(row.userId, (spendByUser.get(row.userId) ?? 0) + priceSum(row.modelId, row._sum));
      }
      const runCountByUser = new Map<string, number>();
      for (const row of runsByUser) {
        if (!row.userId) continue;
        runCountByUser.set(row.userId, row._count.id);
      }

      const people = memberships
        .map(m => ({
          userId: m.userId,
          name: m.user?.name ?? null,
          email: m.user?.email ?? '',
          roleSlug: m.role.slug,
          roleName: m.role.name,
          spendUsd: spendByUser.get(m.userId) ?? 0,
          runs: runCountByUser.get(m.userId) ?? 0,
        }))
        .sort((a, b) => b.spendUsd - a.spendUsd);

      res.json({
        success: true,
        data: {
          days,
          spendUsd: people.reduce((sum, p) => sum + p.spendUsd, 0),
          runs: people.reduce((sum, p) => sum + p.runs, 0),
          totalPeople: people.length,
          // "Used Divo at all in this window", which is the number a manager
          // actually wants — adoption, not headcount.
          activePeople: people.filter(p => p.runs > 0).length,
          people,
        },
      });
    } catch (e) {
      log.error('desktop.team_usage.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Could not read this team’s usage.' });
    }
  });

  return router;
}
