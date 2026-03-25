import { prisma } from '../../utils/prisma';
import {
  MEMORY_ACTIVE_SOFT_CAP,
  MEMORY_ARCHIVE_CAP,
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
