const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { AdminRuntimeService } = require('../dist/modules/admin-runtime/admin-runtime.service');

test('company-admin listTasks only includes resolved tasks for own company', async () => {
  const service = new AdminRuntimeService({
    runtime: {
      listRecent: () => [
        {
          taskId: 'task-1',
          messageId: 'm1',
          channel: 'lark',
          userId: 'u1',
          chatId: 'c1',
          status: 'running',
          plan: [],
          controlSignal: 'running',
          createdAt: '2026-03-05T06:00:00.000Z',
          updatedAt: '2026-03-05T06:00:00.000Z',
          companyId: 'cmp-a',
          scopeVisibility: 'resolved',
          engine: 'langgraph',
        },
        {
          taskId: 'task-2',
          messageId: 'm2',
          channel: 'lark',
          userId: 'u2',
          chatId: 'c2',
          status: 'running',
          plan: [],
          controlSignal: 'running',
          createdAt: '2026-03-05T06:00:00.000Z',
          updatedAt: '2026-03-05T06:00:00.000Z',
          companyId: 'cmp-b',
          scopeVisibility: 'resolved',
          engine: 'langgraph',
        },
        {
          taskId: 'task-3',
          messageId: 'm3',
          channel: 'lark',
          userId: 'u3',
          chatId: 'c3',
          status: 'running',
          plan: [],
          controlSignal: 'running',
          createdAt: '2026-03-05T06:00:00.000Z',
          updatedAt: '2026-03-05T06:00:00.000Z',
          scopeVisibility: 'unresolved',
          engine: 'langgraph',
        },
      ],
      getTask: async (taskId) => {
        if (taskId === 'task-2') {
          return {
            taskId,
            messageId: 'm2',
            channel: 'lark',
            userId: 'u2',
            chatId: 'c2',
            status: 'running',
            plan: [],
            controlSignal: 'running',
            createdAt: '2026-03-05T06:00:00.000Z',
            updatedAt: '2026-03-05T06:00:00.000Z',
            companyId: 'cmp-b',
            scopeVisibility: 'resolved',
            engine: 'langgraph',
            latestCheckpoint: null,
          };
        }
        return null;
      },
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

  const session = {
    userId: 'company-admin',
    role: 'COMPANY_ADMIN',
    companyId: 'cmp-a',
  };

  const list = await service.listTasks(session, 20);
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, 'task-1');

  await assert.rejects(
    () => service.getTask(session, 'task-2'),
    (error) => error && error.status === 404,
  );
});

test('super-admin can list unresolved and cross-company tasks', async () => {
  const tasks = [
    {
      taskId: 'task-a',
      messageId: 'm1',
      channel: 'lark',
      userId: 'u1',
      chatId: 'c1',
      status: 'running',
      plan: [],
      controlSignal: 'running',
      createdAt: '2026-03-05T06:00:00.000Z',
      updatedAt: '2026-03-05T06:00:00.000Z',
      scopeVisibility: 'unresolved',
      engine: 'legacy',
    },
  ];

  const service = new AdminRuntimeService({
    runtime: {
      listRecent: () => tasks,
      getTask: async () => tasks[0],
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

  const session = {
    userId: 'super-admin',
    role: 'SUPER_ADMIN',
  };

  const list = await service.listTasks(session, 10);
  assert.equal(list.length, 1);
  const detail = await service.getTask(session, 'task-a');
  assert.equal(detail.taskId, 'task-a');
});
