import { prisma } from '../../utils/prisma';
import {
  MEMORY_ACTIVE_SOFT_CAP,
  MEMORY_ARCHIVE_CAP,
  MEMORY_ROUTING_THREAD_PINNED_CAP,
  MEMORY_ROUTING_USER_GLOBAL_CAP,
} from './contracts';

const kindPriority = (kind: string): number => {
  switch (kind) {
    case 'response_style':
      return 40;
    case 'identity':
      return 34;
    case 'constraint':
      return 28;
    case 'ongoing_task':
      return 24;
    case 'project':
      return 20;
    case 'decision':
      return 18;
    case 'tool_routing':
      return 26;
    case 'preference':
      return 12;
    default:
      return 0;
  }
};

const activeScore = (item: {
  kind: string;
  confidence: number;
  updatedAt: Date;
  lastConfirmedAt?: Date | null;
}): number => {
  const ageDays = Math.max(0, (Date.now() - item.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
  const recency = Math.max(0, 30 - ageDays);
  return (item.confidence * 100) + recency + kindPriority(item.kind) + (item.lastConfirmedAt ? 12 : 0);
};

class MemoryRetentionService {
  async applyRetention(input: { companyId: string; userId: string }): Promise<void> {
    const now = new Date();

    await prisma.userMemoryItem.updateMany({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        status: 'active',
        kind: { in: ['ongoing_task', 'project'] },
        staleAfterAt: { lt: now },
      },
      data: {
        status: 'archived',
      },
    });
    await prisma.userMemoryItem.updateMany({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        status: 'active',
        kind: 'tool_routing',
        OR: [
          { staleAfterAt: { lt: now } },
          {
            updatedAt: {
              lt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
            },
            confidence: { lt: 0.45 },
          },
        ],
      },
      data: {
        status: 'archived',
      },
    });

    const active = await prisma.userMemoryItem.findMany({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        status: 'active',
      },
      select: {
        id: true,
        kind: true,
        confidence: true,
        updatedAt: true,
        lastConfirmedAt: true,
      },
    });

    if (active.length > MEMORY_ACTIVE_SOFT_CAP) {
      const overflow = [...active]
        .sort((left, right) => activeScore(left) - activeScore(right))
        .slice(0, active.length - MEMORY_ACTIVE_SOFT_CAP);

      if (overflow.length > 0) {
        await prisma.userMemoryItem.updateMany({
          where: {
            id: { in: overflow.map((item) => item.id) },
          },
          data: {
            status: 'archived',
          },
        });
      }
    }

    const routingGlobal = await prisma.userMemoryItem.findMany({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        status: 'active',
        kind: 'tool_routing',
        scope: 'user_global',
      },
      select: {
        id: true,
        kind: true,
        confidence: true,
        updatedAt: true,
        lastConfirmedAt: true,
      },
    });
    if (routingGlobal.length > MEMORY_ROUTING_USER_GLOBAL_CAP) {
      const overflow = [...routingGlobal]
        .sort((left, right) => activeScore(left) - activeScore(right))
        .slice(0, routingGlobal.length - MEMORY_ROUTING_USER_GLOBAL_CAP);
      if (overflow.length > 0) {
        await prisma.userMemoryItem.updateMany({
          where: {
            id: { in: overflow.map((item) => item.id) },
          },
          data: {
            status: 'archived',
          },
        });
      }
    }

    const routingThreadPinned = await prisma.userMemoryItem.findMany({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        status: 'active',
        kind: 'tool_routing',
        scope: 'thread_pinned',
      },
      select: {
        id: true,
        threadId: true,
        conversationKey: true,
        kind: true,
        confidence: true,
        updatedAt: true,
        lastConfirmedAt: true,
      },
    });
    const groupedByThread = routingThreadPinned.reduce<Map<string, Array<typeof routingThreadPinned[number]>>>((acc, item) => {
        const key = `${item.threadId ?? 'null'}:${item.conversationKey ?? 'null'}`;
        const list = acc.get(key) ?? [];
        list.push(item);
        acc.set(key, list);
        return acc;
      }, new Map());
    const toArchive: string[] = [];
    for (const items of groupedByThread.values()) {
      if (items.length <= MEMORY_ROUTING_THREAD_PINNED_CAP) continue;
      const overflow = [...items]
        .sort((left, right) => activeScore(left) - activeScore(right))
        .slice(0, items.length - MEMORY_ROUTING_THREAD_PINNED_CAP);
      toArchive.push(...overflow.map((item) => item.id));
    }
    if (toArchive.length > 0) {
      await prisma.userMemoryItem.updateMany({
        where: {
          id: { in: toArchive },
        },
        data: {
          status: 'archived',
        },
      });
    }

    const archived = await prisma.userMemoryItem.findMany({
      where: {
        companyId: input.companyId,
        userId: input.userId,
        status: { in: ['archived', 'forgotten'] },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      select: {
        id: true,
      },
    });

    if (archived.length > MEMORY_ARCHIVE_CAP) {
      const toDelete = archived.slice(MEMORY_ARCHIVE_CAP).map((item) => item.id);
      if (toDelete.length > 0) {
        await prisma.userMemoryItem.deleteMany({
          where: {
            id: { in: toDelete },
          },
        });
      }
    }
  }
}

export const memoryRetentionService = new MemoryRetentionService();
