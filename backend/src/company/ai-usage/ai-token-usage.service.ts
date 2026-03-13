import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';

export type RecordUsageInput = {
  userId: string;
  companyId: string;
  agentTarget: string;
  modelId: string;
  provider: string;
  channel: string;
  threadId?: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  wasCompacted: boolean;
  mode: 'fast' | 'high' | 'xtreme';
};

export type MonthlyUsageSummary = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  monthlyLimit: number;
  limitExceeded: boolean;
  usageByModel: Record<string, number>;
};

export type MemberUsageRow = {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  totalTokens: number;
  monthlyLimit: number;
  percentUsed: number;
  lastModelId: string | null;
  compactionEvents: number;
};

export type CompanyUsageBreakdown = {
  totalTokens: number;
  byModel: Record<string, { tokens: number; requests: number }>;
  byMode: { fast: number; high: number; xtreme: number };
  compactionRate: number;
  members: MemberUsageRow[];
};

class AiTokenUsageService {
  /**
   * Record a single agent turn's token usage.
   * Fire-and-forget — errors are logged but never thrown.
   */
  async record(input: RecordUsageInput): Promise<void> {
    try {
      await prisma.aiTokenUsage.create({
        data: {
          userId: input.userId,
          companyId: input.companyId,
          agentTarget: input.agentTarget,
          modelId: input.modelId,
          provider: input.provider,
          channel: input.channel,
          threadId: input.threadId,
          estimatedInputTokens: input.estimatedInputTokens,
          estimatedOutputTokens: input.estimatedOutputTokens,
          actualInputTokens: input.actualInputTokens ?? null,
          actualOutputTokens: input.actualOutputTokens ?? null,
          wasCompacted: input.wasCompacted,
          mode: input.mode,
        },
      });
    } catch (err) {
      logger.warn('ai.token.usage.record.failed', { error: err });
    }
  }

  /**
   * Get total tokens used by a user in the current calendar month.
   */
  async getMonthlyUsage(userId: string, companyId: string): Promise<MonthlyUsageSummary> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [rows, policy] = await Promise.all([
      prisma.aiTokenUsage.findMany({
        where: { userId, companyId, createdAt: { gte: startOfMonth } },
        select: {
          estimatedInputTokens: true,
          estimatedOutputTokens: true,
          actualInputTokens: true,
          actualOutputTokens: true,
          modelId: true,
        },
      }),
      prisma.memberTokenPolicy.findUnique({ where: { userId } }),
    ]);

    const monthlyLimit = policy?.monthlyTokenLimit ?? 2_000_000;
    const usageByModel: Record<string, number> = {};

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const row of rows) {
      const inputT = row.actualInputTokens ?? row.estimatedInputTokens;
      const outputT = row.actualOutputTokens ?? row.estimatedOutputTokens;
      totalInputTokens += inputT;
      totalOutputTokens += outputT;
      usageByModel[row.modelId] = (usageByModel[row.modelId] ?? 0) + inputT + outputT;
    }

    const totalTokens = totalInputTokens + totalOutputTokens;

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      monthlyLimit,
      limitExceeded: totalTokens >= monthlyLimit,
      usageByModel,
    };
  }

  /**
   * Quick limit check — avoids full summary computation on hot path.
   * Returns true if the user is at or over their monthly limit.
   */
  async checkLimitExceeded(userId: string, companyId: string): Promise<boolean> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [policy, aggregate] = await Promise.all([
      prisma.memberTokenPolicy.findUnique({ where: { userId } }),
      prisma.aiTokenUsage.aggregate({
        _sum: {
          estimatedInputTokens: true,
          estimatedOutputTokens: true,
        },
        where: { userId, companyId, createdAt: { gte: startOfMonth } },
      }),
    ]);

    const limit = policy?.monthlyTokenLimit ?? 2_000_000;
    const totalUsed = (aggregate._sum.estimatedInputTokens ?? 0) + (aggregate._sum.estimatedOutputTokens ?? 0);
    return totalUsed >= limit;
  }

  /**
   * Full company breakdown for the admin dashboard.
   */
  async getCompanyBreakdown(companyId: string, months = 1): Promise<CompanyUsageBreakdown> {
    const since = new Date();
    since.setMonth(since.getMonth() - Math.max(0, months - 1));
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const rows = await prisma.aiTokenUsage.findMany({
      where: { companyId, createdAt: { gte: since } },
      select: {
        userId: true,
        modelId: true,
        mode: true,
        wasCompacted: true,
        estimatedInputTokens: true,
        estimatedOutputTokens: true,
        actualInputTokens: true,
        actualOutputTokens: true,
      },
    });

    const byModel: Record<string, { tokens: number; requests: number }> = {};
    const byMode = { fast: 0, high: 0, xtreme: 0 };
    const byMember: Record<string, { tokens: number; compacted: number; lastModel: string; name: string | null; email: string | null }> = {};
    let totalTokens = 0;
    let totalCompacted = 0;

    for (const row of rows) {
      const used = (row.actualInputTokens ?? row.estimatedInputTokens) +
        (row.actualOutputTokens ?? row.estimatedOutputTokens);
      totalTokens += used;

      byModel[row.modelId] = byModel[row.modelId] ?? { tokens: 0, requests: 0 };
      byModel[row.modelId].tokens += used;
      byModel[row.modelId].requests += 1;

      if (row.mode === 'fast') byMode.fast += used;
      else if (row.mode === 'xtreme') byMode.xtreme += used;
      else byMode.high += used;

      byMember[row.userId] = byMember[row.userId] ?? { tokens: 0, compacted: 0, lastModel: row.modelId, name: null, email: null };
      byMember[row.userId].tokens += used;
      byMember[row.userId].lastModel = row.modelId;
      if (row.wasCompacted) {
        byMember[row.userId].compacted += 1;
        totalCompacted += 1;
      }
    }

    const userIds = Object.keys(byMember);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });

    for (const user of users) {
      if (byMember[user.id]) {
        byMember[user.id].name = user.name;
        byMember[user.id].email = user.email;
      }
    }

    const policies = await prisma.memberTokenPolicy.findMany({ where: { companyId } });
    const policyMap = new Map(policies.map((p) => [p.userId, p.monthlyTokenLimit]));

    const members: MemberUsageRow[] = Object.entries(byMember).map(([userId, data]) => {
      const limit = policyMap.get(userId) ?? 2_000_000;
      return {
        userId,
        userName: data.name,
        userEmail: data.email,
        totalTokens: data.tokens,
        monthlyLimit: limit,
        percentUsed: Number(((data.tokens / limit) * 100).toFixed(2)),
        lastModelId: data.lastModel,
        compactionEvents: data.compacted,
      };
    });

    return {
      totalTokens,
      byModel,
      byMode,
      compactionRate: rows.length > 0 ? Math.round((totalCompacted / rows.length) * 100) : 0,
      members,
    };
  }

  /**
   * Set or update monthly token limit for a user.
   */
  async setMemberLimit(userId: string, companyId: string, monthlyTokenLimit: number): Promise<void> {
    await prisma.memberTokenPolicy.upsert({
      where: { userId },
      create: { userId, companyId, monthlyTokenLimit },
      update: { monthlyTokenLimit },
    });
  }
}

export const aiTokenUsageService = new AiTokenUsageService();
