import { prisma } from '../../../utils/prisma';
import { logger } from '../../../utils/logger';

const EXECUTION_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EXECUTION_RETENTION_OLDER_THAN_DAYS = 7;
const EXECUTION_RETENTION_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export class ExecutionRetentionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.cleanupExpiredRuns().catch((error) => {
        logger.error('execution.retention.cleanup.failed', {
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      });
    }, EXECUTION_RETENTION_INTERVAL_MS);

    void this.cleanupExpiredRuns().catch((error) => {
      logger.error('execution.retention.cleanup.failed', {
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    });

    logger.info('execution.retention.scheduler.started', {
      intervalMs: EXECUTION_RETENTION_INTERVAL_MS,
      olderThanDays: EXECUTION_RETENTION_OLDER_THAN_DAYS,
      statuses: EXECUTION_RETENTION_STATUSES,
    });
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async cleanupExpiredRuns(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const cutoff = new Date(Date.now() - EXECUTION_RETENTION_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000);
      const candidates = await prisma.executionRun.findMany({
        where: {
          status: { in: [...EXECUTION_RETENTION_STATUSES] },
          startedAt: { lt: cutoff },
        },
        select: {
          id: true,
          startedAt: true,
          _count: {
            select: {
              events: true,
            },
          },
        },
        orderBy: { startedAt: 'asc' },
        take: 1000,
      });

      if (candidates.length === 0) {
        logger.info('execution.retention.cleanup.completed', {
          deletedRuns: 0,
          deletedEvents: 0,
          clearedWorkflowLinks: 0,
          cutoff: cutoff.toISOString(),
        });
        return;
      }

      const candidateIds = candidates.map((candidate) => candidate.id);
      const candidateEventCount = candidates.reduce((sum, candidate) => sum + candidate._count.events, 0);
      const result = await prisma.$transaction(async (tx) => {
        const cleared = await tx.scheduledWorkflowRun.updateMany({
          where: {
            executionRunId: {
              in: candidateIds,
            },
          },
          data: {
            executionRunId: null,
          },
        });

        const deleted = await tx.executionRun.deleteMany({
          where: {
            id: {
              in: candidateIds,
            },
          },
        });

        return {
          clearedWorkflowLinks: cleared.count,
          deletedRuns: deleted.count,
        };
      });

      logger.info('execution.retention.cleanup.completed', {
        ...result,
        deletedEvents: candidateEventCount,
        cutoff: cutoff.toISOString(),
        oldestDeletedStartedAt: candidates[0]?.startedAt.toISOString() ?? null,
        newestDeletedStartedAt: candidates[candidates.length - 1]?.startedAt.toISOString() ?? null,
      });
    } finally {
      this.running = false;
    }
  }
}

export const executionRetentionService = new ExecutionRetentionService();
