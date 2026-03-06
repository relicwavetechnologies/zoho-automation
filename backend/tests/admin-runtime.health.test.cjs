const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { AdminRuntimeService } = require('../dist/modules/admin-runtime/admin-runtime.service');

test('admin runtime health reports dependency statuses and degraded overall when a dependency fails', async () => {
  const service = new AdminRuntimeService({
    runtime: {
      listRecent: () => [],
      getTask: async () => null,
      control: async () => null,
      requeue: async () => null,
    },
    checkpoints: {
      getHistory: async () => [],
      getLatest: async () => null,
    },
    hitlActions: {
      getByTaskId: async () => null,
    },
    redis: {
      health: async () => ({ ok: true, latencyMs: 4 }),
    },
    vector: {
      health: async () => ({
        ok: false,
        backend: 'qdrant',
        collection: 'test_collection',
        latencyMs: 18,
        error: 'qdrant timeout',
      }),
    },
    queueFactory: () => ({
      getJobCounts: async () => ({ waiting: 2, active: 1, delayed: 0, failed: 0, completed: 10 }),
    }),
    db: {
      zohoConnection: {
        count: async ({ where }) => {
          if (where && where.tokenFailureCode && where.tokenFailureCode.not === null) {
            return 0;
          }
          return 1;
        },
      },
    },
    now: () => new Date('2026-03-05T06:40:00.000Z'),
  });

  const health = await service.getHealth({
    userId: 'u-admin',
    role: 'SUPER_ADMIN',
  });

  assert.equal(health.overall, 'degraded');
  assert.equal(health.generatedAt, '2026-03-05T06:40:00.000Z');
  assert.equal(health.dependencies.length, 5);

  const redis = health.dependencies.find((entry) => entry.name === 'redis');
  const qdrant = health.dependencies.find((entry) => entry.name === 'qdrant');
  const queue = health.dependencies.find((entry) => entry.name === 'queue');
  const openai = health.dependencies.find((entry) => entry.name === 'openai');
  const zoho = health.dependencies.find((entry) => entry.name === 'zoho');

  assert.equal(redis?.ok, true);
  assert.equal(qdrant?.ok, false);
  assert.equal(qdrant?.error, 'qdrant timeout');
  assert.deepEqual(queue?.detail?.counts, {
    waiting: 2,
    active: 1,
    delayed: 0,
    failed: 0,
    completed: 10,
  });
  assert.equal(openai?.ok, true);
  assert.equal(zoho?.ok, true);
});
