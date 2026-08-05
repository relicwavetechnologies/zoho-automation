import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeProjectionService } from '../../src/application/knowledge/knowledge-projection.service.ts';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    eventType: 'knowledge.version.applied',
    status: 'processing',
    leaseToken: 'lease-1',
    mutation: {
      kind: 'memory',
      requesterId: 'user-1',
      resource: {
        id: 'resource-1',
        companyId: 'company-1',
        scope: 'personal',
        ownerUserId: 'user-1',
        departmentId: null,
        status: 'active',
        currentVersion: 1,
      },
      appliedVersion: { version: 1, contentJson: { facts: ['Use tables.'] } },
    },
    ...overrides,
  };
}

function memoryProjection(writes: { count: number }) {
  return {
    async projectExplicitResource() { writes.count += 1; },
    async removeProjectedResource() { writes.count += 1; },
  };
}

function service(db: unknown, memory: unknown) {
  return new KnowledgeProjectionService({
    prisma: db as never,
    memory: memory as never,
    logger: logger as never,
    options: { batchSize: 5, maxAttempts: 3, retryBaseMs: 1, processingLeaseMs: 60_000 },
  });
}

describe('KnowledgeProjectionService fencing', () => {
  it('allows only one of two overlapping workers to claim a resource event', async () => {
    let batchClaims = 0;
    let leaseToken = '';
    let completed = 0;
    const writes = { count: 0 };
    const current = event();
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: async () => batchClaims++ === 0 ? [{ id: 'event-1' }] : [],
        knowledgeOutbox: {
          updateMany: async ({ data }: { data: { leaseToken: string } }) => {
            leaseToken = data.leaseToken;
            return { count: 1 };
          },
        },
      }),
      knowledgeOutbox: {
        findUnique: async () => ({ ...current, leaseToken }),
        updateMany: async () => { completed += 1; return { count: 1 }; },
      },
      knowledgeResource: {
        findUnique: async () => ({ status: 'active', currentVersion: 1 }),
      },
    };

    await Promise.all([service(db, memoryProjection(writes)).drain(), service(db, memoryProjection(writes)).drain()]);

    assert.equal(writes.count, 1);
    assert.equal(completed, 1);
  });

  it('does not project an old version after a newer canonical version exists', async () => {
    const writes = { count: 0 };
    let claimedLease = '';
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: async () => [{ id: 'event-1' }],
        knowledgeOutbox: {
          updateMany: async ({ data }: { data: { leaseToken: string } }) => {
            claimedLease = data.leaseToken;
            return { count: 1 };
          },
        },
      }),
      knowledgeOutbox: {
        findMany: async () => [{ id: 'event-1' }],
        updateMany: async ({ data }: { data: { leaseToken: string } }) => {
          claimedLease = data.leaseToken;
          return { count: 1 };
        },
        findUnique: async () => ({ ...event(), leaseToken: claimedLease }),
      },
      knowledgeResource: {
        findUnique: async () => ({ status: 'active', currentVersion: 2 }),
      },
    };

    await service(db, memoryProjection(writes)).projectMutation('mutation-1');

    assert.equal(writes.count, 0);
  });

  it('does not let a stale worker complete or project after its lease is replaced', async () => {
    const writes = { count: 0 };
    let completionAttempts = 0;
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: async () => [{ id: 'event-1' }],
        knowledgeOutbox: { updateMany: async () => ({ count: 1 }) },
      }),
      knowledgeOutbox: {
        findMany: async () => [{ id: 'event-1' }],
        updateMany: async () => ({ count: 1 }),
        findUnique: async () => ({ ...event(), leaseToken: 'new-worker-lease' }),
      },
      knowledgeResource: {
        findUnique: async () => ({ status: 'active', currentVersion: 1 }),
      },
    };
    const originalUpdateMany = db.knowledgeOutbox.updateMany;
    db.knowledgeOutbox.updateMany = async () => {
      completionAttempts += 1;
      return originalUpdateMany();
    };

    await service(db, memoryProjection(writes)).projectMutation('mutation-1');

    assert.equal(writes.count, 0);
    assert.equal(completionAttempts, 0);
  });

  it('fences a delete race when canonical deletion has not committed', async () => {
    const writes = { count: 0 };
    let claimedLease = '';
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        $queryRaw: async () => [{ id: 'event-1' }],
        knowledgeOutbox: { updateMany: async () => ({ count: 1 }) },
      }),
      knowledgeOutbox: {
        findMany: async () => [{ id: 'event-1' }],
        updateMany: async ({ data }: { data: { leaseToken: string } }) => {
          claimedLease = data.leaseToken;
          return { count: 1 };
        },
        findUnique: async () => ({ ...event({ eventType: 'knowledge.resource.deleted' }), leaseToken: claimedLease }),
      },
      knowledgeResource: {
        findUnique: async () => ({ status: 'active', currentVersion: 1 }),
      },
    };

    await service(db, memoryProjection(writes)).projectMutation('mutation-1');

    assert.equal(writes.count, 0);
  });

  it('does not create another skill revision when retrying an already projected event', async () => {
    let leaseToken = '';
    let transactions = 0;
    const skillEvent = event({
      mutation: {
        kind: 'skill',
        requesterId: 'user-1',
        resource: {
          id: 'resource-1',
          companyId: 'company-1',
          scope: 'company',
          ownerUserId: null,
          departmentId: null,
          status: 'active',
          currentVersion: 1,
        },
        appliedVersion: {
          version: 1,
          contentJson: {
            name: 'Company procedure',
            slug: 'company-procedure',
            summary: 'Follow the company procedure.',
            markdown: '# Company procedure\n\nFollow it.',
            toolIds: ['knowledge'],
            tags: ['procedure'],
          },
        },
      },
    });
    const db = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
        transactions += 1;
        return callback({
          $queryRaw: async () => [{ id: 'event-1' }],
          knowledgeOutbox: {
            updateMany: async ({ data }: { data: { leaseToken: string } }) => {
              leaseToken = data.leaseToken;
              return { count: 1 };
            },
          },
        });
      },
      knowledgeOutbox: {
        findMany: async () => [{ id: 'event-1' }],
        findUnique: async () => ({ ...skillEvent, leaseToken }),
        updateMany: async () => ({ count: 1 }),
      },
      knowledgeResource: {
        findUnique: async () => ({ status: 'active', currentVersion: 1 }),
      },
      skill: {
        findUnique: async () => ({
          scope: 'company',
          departmentId: null,
          name: 'Company procedure',
          slug: 'company-procedure',
          summary: 'Follow the company procedure.',
          markdown: '# Company procedure\n\nFollow it.',
          toolIds: ['knowledge'],
          tags: ['procedure'],
          status: 'active',
          accessGrants: [{ granteeType: 'company', granteeId: 'company-1' }],
        }),
      },
    };

    await service(db, null).projectMutation('mutation-1');

    assert.equal(transactions, 1, 'matching projection must skip the skill write transaction');
  });
});
