import assert from 'node:assert/strict';

import { runtimeTaskStore } from '../src/company/orchestration/runtime-task.store';
import { taskFsm } from '../src/company/orchestration/task-fsm';
import { prisma } from '../src/utils/prisma';

type TaskStatus = 'pending' | 'running' | 'hitl' | 'done' | 'failed' | 'cancelled';

type TaskRunRow = {
  id: string;
  companyId: string;
  conversationKey: string;
  channel: string;
  status: TaskStatus;
  inputMessage: unknown;
  currentStep?: string | null;
  failureReason?: string | null;
  requeueCount: number;
  lastHeartbeatAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const rows = new Map<string, TaskRunRow>();
let idCounter = 1;
let findManyCalls = 0;

const now = () => new Date();

const cloneRow = (row: TaskRunRow) => ({ ...row });

const originalTaskRun = (prisma as any).taskRun;

(prisma as any).taskRun = {
  create: async ({ data }: any) => {
    const row: TaskRunRow = {
      id: `task_${idCounter++}`,
      companyId: data.companyId,
      conversationKey: data.conversationKey,
      channel: data.channel,
      status: data.status,
      inputMessage: data.inputMessage,
      currentStep: null,
      failureReason: null,
      requeueCount: 0,
      lastHeartbeatAt: null,
      completedAt: null,
      failedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    rows.set(row.id, row);
    return cloneRow(row);
  },
  update: async ({ where, data }: any) => {
    const row = rows.get(where.id);
    assert.ok(row, `Missing task row ${where.id}`);
    if (data.status !== undefined) row.status = data.status;
    if (data.currentStep !== undefined) row.currentStep = data.currentStep;
    if (data.failureReason !== undefined) row.failureReason = data.failureReason;
    if (data.failedAt !== undefined) row.failedAt = data.failedAt;
    if (data.completedAt !== undefined) row.completedAt = data.completedAt;
    if (data.lastHeartbeatAt !== undefined) row.lastHeartbeatAt = data.lastHeartbeatAt;
    if (data.requeueCount?.increment) row.requeueCount += data.requeueCount.increment;
    row.updatedAt = now();
    rows.set(row.id, row);
    return cloneRow(row);
  },
  updateMany: async ({ where, data }: any) => {
    let count = 0;
    for (const row of rows.values()) {
      const staleEnough =
        !where.lastHeartbeatAt?.lt || ((row.lastHeartbeatAt?.getTime() ?? 0) < where.lastHeartbeatAt.lt.getTime());
      if (row.status === where.status && staleEnough) {
        row.status = data.status;
        row.failureReason = data.failureReason;
        row.failedAt = data.failedAt;
        row.updatedAt = now();
        count += 1;
      }
    }
    return { count };
  },
  findMany: async ({ where }: any) => {
    findManyCalls += 1;
    return [...rows.values()]
      .filter((row) =>
        row.companyId === where.companyId
        && row.conversationKey === where.conversationKey
        && where.status.in.includes(row.status))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(cloneRow);
  },
};

const uniqueConversation = (label: string) => `conversation:${label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

async function run(): Promise<void> {
  const companyId = 'company_1';

  const lifecycleConversation = uniqueConversation('lifecycle');
  const lifecycleTaskId = await taskFsm.create({
    companyId,
    conversationKey: lifecycleConversation,
    channel: 'lark',
    inputMessage: { text: 'hello' },
  });
  runtimeTaskStore.create({
    taskId: lifecycleTaskId,
    queueJobId: 'job_1',
    messageId: 'msg_1',
    channel: 'lark',
    conversationKey: lifecycleConversation,
    userId: 'user_1',
    chatId: lifecycleConversation,
    companyId,
    status: 'pending',
    plan: [],
  });
  await taskFsm.start(lifecycleTaskId);
  await taskFsm.complete(lifecycleTaskId);
  const lifecycleRow = rows.get(lifecycleTaskId);
  assert.equal(lifecycleRow?.status, 'done');
  assert.ok(lifecycleRow?.completedAt instanceof Date);

  const staleConversation = uniqueConversation('stale');
  const staleTaskId = await taskFsm.create({
    companyId,
    conversationKey: staleConversation,
    channel: 'lark',
    inputMessage: { text: 'stale' },
  });
  rows.set(staleTaskId, {
    ...rows.get(staleTaskId)!,
    status: 'running',
    lastHeartbeatAt: new Date(Date.now() - 180_000),
  });
  const recoveredCount = await taskFsm.recoverStaleRunning(120_000);
  assert.equal(recoveredCount >= 1, true);
  const staleActive = await taskFsm.getActiveForConversation(companyId, staleConversation);
  assert.equal(staleActive, null);

  const requeueConversation = uniqueConversation('requeue');
  const requeueTaskId = await taskFsm.create({
    companyId,
    conversationKey: requeueConversation,
    channel: 'lark',
    inputMessage: { text: 'requeue' },
  });
  runtimeTaskStore.create({
    taskId: requeueTaskId,
    queueJobId: 'job_2',
    messageId: 'msg_2',
    channel: 'lark',
    conversationKey: requeueConversation,
    userId: 'user_2',
    chatId: requeueConversation,
    companyId,
    status: 'pending',
    plan: [],
  });
  await taskFsm.requeue(requeueTaskId);
  await taskFsm.requeue(requeueTaskId);
  assert.equal(rows.get(requeueTaskId)?.requeueCount, 2);

  const cacheConversation = uniqueConversation('cache');
  runtimeTaskStore.create({
    taskId: 'cache_task',
    queueJobId: 'job_cache',
    messageId: 'msg_cache',
    channel: 'lark',
    conversationKey: cacheConversation,
    userId: 'user_cache',
    chatId: cacheConversation,
    companyId,
    status: 'running',
    plan: [],
  });
  findManyCalls = 0;
  const cached = await taskFsm.getActiveForConversation(companyId, cacheConversation);
  assert.deepEqual(cached, { id: 'cache_task', status: 'running' });
  assert.equal(findManyCalls, 0);

  const lockConversation = uniqueConversation('lock');
  const runningTaskId = await taskFsm.create({
    companyId,
    conversationKey: lockConversation,
    channel: 'lark',
    inputMessage: { text: 'running' },
  });
  const pendingTaskId = await taskFsm.create({
    companyId,
    conversationKey: lockConversation,
    channel: 'lark',
    inputMessage: { text: 'pending' },
  });
  rows.set(runningTaskId, {
    ...rows.get(runningTaskId)!,
    status: 'running',
    updatedAt: new Date(Date.now() - 5_000),
  });
  rows.set(pendingTaskId, {
    ...rows.get(pendingTaskId)!,
    status: 'pending',
    updatedAt: new Date(),
  });
  const activeForLock = await taskFsm.getActiveForConversation(companyId, lockConversation);
  assert.deepEqual(activeForLock, { id: runningTaskId, status: 'running' });

  console.log('task-fsm-harness-ok');
}

run()
  .finally(() => {
    (prisma as any).taskRun = originalTaskRun;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
