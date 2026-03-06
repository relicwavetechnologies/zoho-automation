const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { AdminRuntimeService } = require('../dist/modules/admin-runtime/admin-runtime.service');

const sessionCompanyAdmin = {
  userId: 'admin-1',
  role: 'COMPANY_ADMIN',
  companyId: 'cmp-a',
};

test('company-admin controlTask is denied for non-scoped task', async () => {
  const service = new AdminRuntimeService({
    runtime: {
      listRecent: () => [],
      getTask: async () => ({
        taskId: 'task-x',
        messageId: 'm-x',
        channel: 'lark',
        userId: 'u-x',
        chatId: 'c-x',
        status: 'running',
        plan: [],
        controlSignal: 'running',
        createdAt: '2026-03-05T06:00:00.000Z',
        updatedAt: '2026-03-05T06:00:00.000Z',
        companyId: 'cmp-b',
        scopeVisibility: 'resolved',
      }),
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
    redis: { health: async () => ({ ok: true }) },
    vector: { health: async () => ({ ok: true, backend: 'qdrant', collection: 'x' }) },
    queueFactory: () => ({ getJobCounts: async () => ({}) }),
    db: { zohoConnection: { count: async () => 0 } },
  });

  await assert.rejects(
    () => service.controlTask(sessionCompanyAdmin, 'task-x', { action: 'pause' }),
    (error) => error && error.status === 404,
  );
});

test('company-admin recoverTask succeeds for scoped task with finalized checkpoint', async () => {
  let requeued = false;
  const service = new AdminRuntimeService({
    runtime: {
      listRecent: () => [],
      getTask: async () => ({
        taskId: 'task-a',
        messageId: 'm-a',
        channel: 'lark',
        userId: 'u-a',
        chatId: 'c-a',
        status: 'done',
        plan: [],
        controlSignal: 'running',
        createdAt: '2026-03-05T06:00:00.000Z',
        updatedAt: '2026-03-05T06:00:00.000Z',
        companyId: 'cmp-a',
        scopeVisibility: 'resolved',
      }),
      control: async () => ({ taskId: 'task-a' }),
      requeue: async () => {
        requeued = true;
      },
    },
    checkpoints: {
      getHistory: async () => [],
      getLatest: async () => ({
        taskId: 'task-a',
        version: 4,
        node: 'finalize.task',
        updatedAt: '2026-03-05T06:10:00.000Z',
        state: {
          channel: 'lark',
          userId: 'u-a',
          chatId: 'c-a',
          chatType: 'group',
          messageId: 'm-a',
          timestamp: '2026-03-05T06:00:00.000Z',
          text: 'hello',
        },
      }),
    },
    hitlActions: {
      getByTaskId: async () => null,
    },
    redis: { health: async () => ({ ok: true }) },
    vector: { health: async () => ({ ok: true, backend: 'qdrant', collection: 'x' }) },
    queueFactory: () => ({ getJobCounts: async () => ({}) }),
    db: { zohoConnection: { count: async () => 0 } },
  });

  const result = await service.recoverTask(sessionCompanyAdmin, 'task-a');

  assert.equal(result.status, 'already_completed');
  assert.equal(result.recoveryMode, 'resume_from_checkpoint');
  assert.equal(requeued, false);
});
