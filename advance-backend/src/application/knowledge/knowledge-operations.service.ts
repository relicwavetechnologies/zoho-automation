import type { PrismaClient } from '../../generated/prisma';

export interface KnowledgeOperationsOptions {
  readonly pendingAgeWarningMs: number;
  readonly processingLeaseMs: number;
}

export interface KnowledgeOperationsHealth {
  readonly status: 'ok' | 'degraded';
  readonly outbox: {
    readonly pending: number;
    readonly processing: number;
    readonly failed: number;
    readonly staleProcessing: number;
    readonly oldestPendingAgeMs: number | null;
  };
  readonly documents: {
    readonly processing: number;
    readonly failed: number;
    readonly staleProcessing: number;
  };
  readonly learning: {
    readonly queued: number;
    readonly processing: number;
    readonly failed: number;
    readonly staleProcessing: number;
    readonly oldestQueuedAgeMs: number | null;
  };
  readonly hindsight: {
    readonly status: 'ok' | 'degraded' | 'disabled';
    readonly version?: string;
    readonly error?: string;
  };
}

/** Operational read and repair surface for the canonical knowledge pipeline. */
export class KnowledgeOperationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: KnowledgeOperationsOptions,
    private readonly dependencies: {
      readonly hindsight?: {
        readiness(): Promise<{
          readonly status: 'ok' | 'degraded';
          readonly version?: string;
          readonly error?: string;
        }>;
      };
    } = {},
  ) {}

  async health(now = new Date(), companyId?: string): Promise<KnowledgeOperationsHealth> {
    const staleBefore = new Date(now.getTime() - this.options.processingLeaseMs);
    const outboxWhere = companyId ? { mutation: { companyId } } : {};
    const companyWhere = companyId ? { companyId } : {};
    const [
      outboxGroups,
      oldestPending,
      staleProcessing,
      documentGroups,
      learningGroups,
      staleDocuments,
      staleLearning,
      oldestLearning,
      hindsight,
    ] = await Promise.all([
      this.prisma.knowledgeOutbox.groupBy({ by: ['status'], where: outboxWhere, _count: { _all: true } }),
      this.prisma.knowledgeOutbox.findFirst({
        where: { ...outboxWhere, status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.knowledgeOutbox.count({
        where: { ...outboxWhere, status: 'processing', lockedAt: { lt: staleBefore } },
      }),
      this.prisma.knowledgeFileDocument.groupBy({ by: ['status'], where: companyWhere, _count: { _all: true } }),
      this.prisma.knowledgeLearningJob.groupBy({ by: ['status'], where: companyWhere, _count: { _all: true } }),
      this.prisma.knowledgeFileDocument.count({
        where: { ...companyWhere, status: 'processing', lockedAt: { lt: staleBefore } },
      }),
      this.prisma.knowledgeLearningJob.count({
        where: { ...companyWhere, status: 'processing', lockedAt: { lt: staleBefore } },
      }),
      this.prisma.knowledgeLearningJob.findFirst({
        where: { ...companyWhere, status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.dependencies.hindsight?.readiness() ?? Promise.resolve({ status: 'degraded' as const, error: 'not_configured' }),
    ]);
    const outbox = countByStatus(outboxGroups);
    const documents = countByStatus(documentGroups);
    const learning = countByStatus(learningGroups);
    const oldestPendingAgeMs = oldestPending
      ? Math.max(0, now.getTime() - oldestPending.createdAt.getTime())
      : null;
    const oldestQueuedAgeMs = oldestLearning
      ? Math.max(0, now.getTime() - oldestLearning.createdAt.getTime())
      : null;
    const degraded = (outbox['failed'] ?? 0) > 0
      || staleProcessing > 0
      || (oldestPendingAgeMs !== null && oldestPendingAgeMs > this.options.pendingAgeWarningMs)
      || (documents['failed'] ?? 0) > 0
      || staleDocuments > 0
      || (learning['failed'] ?? 0) > 0
      || staleLearning > 0
      || (oldestQueuedAgeMs !== null && oldestQueuedAgeMs > this.options.pendingAgeWarningMs)
      || (this.dependencies.hindsight !== undefined && hindsight.status === 'degraded');

    return {
      status: degraded ? 'degraded' : 'ok',
      outbox: {
        pending: outbox['pending'] ?? 0,
        processing: outbox['processing'] ?? 0,
        failed: outbox['failed'] ?? 0,
        staleProcessing,
        oldestPendingAgeMs,
      },
      documents: {
        processing: documents['processing'] ?? 0,
        failed: documents['failed'] ?? 0,
        staleProcessing: staleDocuments,
      },
      learning: {
        queued: learning['queued'] ?? 0,
        processing: learning['processing'] ?? 0,
        failed: learning['failed'] ?? 0,
        staleProcessing: staleLearning,
        oldestQueuedAgeMs,
      },
      hindsight: this.dependencies.hindsight
        ? hindsight
        : { status: 'disabled' },
    };
  }

  async listFailedProjections(input: { readonly companyId: string; readonly limit: number }) {
    return this.prisma.knowledgeOutbox.findMany({
      where: { status: 'failed', mutation: { companyId: input.companyId } },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(1, Math.min(input.limit, 100)),
      select: {
        id: true,
        eventType: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        mutation: {
          select: {
            id: true,
            kind: true,
            scope: true,
            logicalKey: true,
            department: { select: { name: true } },
          },
        },
      },
    });
  }

  async retryFailedProjection(input: {
    readonly companyId: string;
    readonly eventId: string;
  }): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext('knowledge-outbox-repair'), hashtext(${input.eventId}))::text
      `;
      const event = await tx.knowledgeOutbox.findFirst({
        where: {
          id: input.eventId,
          status: 'failed',
          mutation: { companyId: input.companyId },
        },
        select: { id: true },
      });
      if (!event) return false;
      const updated = await tx.knowledgeOutbox.updateMany({
        where: { id: event.id, status: 'failed' },
        data: {
          status: 'pending',
          attempts: 0,
          availableAt: new Date(),
          lockedAt: null,
          completedAt: null,
          lastError: null,
        },
      });
      return updated.count === 1;
    });
  }
}

function countByStatus(rows: readonly { status: string; _count: { _all: number } }[]): Record<string, number> {
  return Object.fromEntries(rows.map(row => [row.status, row._count._all]));
}
