import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeOperationsService } from '../../src/application/knowledge/knowledge-operations.service.ts';

const NOW = new Date('2026-08-01T00:10:00.000Z');

describe('KnowledgeOperationsService', () => {
  it('degrades when a projection is terminal or the oldest pending event exceeds policy', async () => {
    const service = new KnowledgeOperationsService({
      knowledgeOutbox: {
        groupBy: async () => [
          { status: 'pending', _count: { _all: 2 } },
          { status: 'failed', _count: { _all: 1 } },
        ],
        findFirst: async () => ({ createdAt: new Date('2026-08-01T00:00:00.000Z') }),
        count: async () => 0,
      },
      knowledgeFileDocument: { groupBy: async () => [], count: async () => 0 },
      knowledgeLearningJob: { groupBy: async () => [], count: async () => 0, findFirst: async () => null },
    } as never, {
      pendingAgeWarningMs: 5 * 60_000,
      processingLeaseMs: 5 * 60_000,
    });

    const health = await service.health(NOW);
    assert.equal(health.status, 'degraded');
    assert.equal(health.outbox.failed, 1);
    assert.equal(health.outbox.oldestPendingAgeMs, 10 * 60_000);
  });

  it('degrades when parsing or learning workers are stale even without terminal rows', async () => {
    const service = new KnowledgeOperationsService({
      knowledgeOutbox: {
        groupBy: async () => [],
        findFirst: async () => null,
        count: async () => 0,
      },
      knowledgeFileDocument: { groupBy: async () => [], count: async () => 1 },
      knowledgeLearningJob: {
        groupBy: async () => [{ status: 'queued', _count: { _all: 1 } }],
        count: async () => 1,
        findFirst: async () => ({ createdAt: new Date('2026-08-01T00:00:00.000Z') }),
      },
    } as never, {
      pendingAgeWarningMs: 5 * 60_000,
      processingLeaseMs: 5 * 60_000,
    });

    const health = await service.health(NOW);
    assert.equal(health.status, 'degraded');
    assert.equal(health.documents.staleProcessing, 1);
    assert.equal(health.learning.staleProcessing, 1);
    assert.equal(health.learning.oldestQueuedAgeMs, 10 * 60_000);
  });

  it('atomically requeues only a failed projection belonging to the company', async () => {
    let update: Record<string, unknown> | undefined;
    const service = new KnowledgeOperationsService({
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: async () => [{ lock: 'ok' }],
        knowledgeOutbox: {
          findFirst: async ({ where }: { where: { mutation: { companyId: string } } }) =>
            where.mutation.companyId === 'company-1' ? { id: 'event-1' } : null,
          updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            update = data;
            return { count: 1 };
          },
        },
      }),
    } as never, {
      pendingAgeWarningMs: 300_000,
      processingLeaseMs: 300_000,
    });

    assert.equal(await service.retryFailedProjection({
      companyId: 'company-1',
      eventId: 'event-1',
    }), true);
    assert.equal(update?.['status'], 'pending');
    assert.equal(update?.['attempts'], 0);
    assert.equal(update?.['lastError'], null);
  });

  it('surfaces Hindsight readiness and degrades when the projection backend is unavailable', async () => {
    const service = new KnowledgeOperationsService({
      knowledgeOutbox: { groupBy: async () => [], findFirst: async () => null, count: async () => 0 },
      knowledgeFileDocument: { groupBy: async () => [], count: async () => 0 },
      knowledgeLearningJob: { groupBy: async () => [], count: async () => 0, findFirst: async () => null },
    } as never, {
      pendingAgeWarningMs: 300_000,
      processingLeaseMs: 300_000,
    }, {
      hindsight: { readiness: async () => ({ status: 'degraded', error: 'connection refused' }) },
    });

    const health = await service.health(NOW);
    assert.equal(health.status, 'degraded');
    assert.deepEqual(health.hindsight, { status: 'degraded', error: 'connection refused' });
  });
});
