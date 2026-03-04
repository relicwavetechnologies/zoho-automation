import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';

import type { NormalizedIncomingMessageDTO } from '../../contracts';
import { runtimeTaskStore, type RuntimeTaskSnapshot } from '../../orchestration/runtime-task.store';
import { redisConnection } from './redis.connection';

export const ORCHESTRATION_QUEUE_NAME = 'emiac-orchestration-v0';
export const ORCHESTRATION_JOB_NAME = 'orchestration.task.execute' as const;

export type OrchestrationJobData = {
  taskId: string;
  message: NormalizedIncomingMessageDTO;
};

const queue = new Queue<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME>(ORCHESTRATION_QUEUE_NAME, {
  connection: redisConnection.getClient(),
});

const buildSafeJobId = (...parts: Array<string | number>): string =>
  parts
    .map((part) =>
      String(part)
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_'),
    )
    .filter((part) => part.length > 0)
    .join('__');

export const enqueueOrchestrationTask = async (
  message: NormalizedIncomingMessageDTO,
): Promise<RuntimeTaskSnapshot> => {
  const taskId = randomUUID();
  const task = runtimeTaskStore.create({
    taskId,
    messageId: message.messageId,
    channel: message.channel,
    userId: message.userId,
    chatId: message.chatId,
    status: 'pending',
    plan: [],
  });

  await queue.add(
    ORCHESTRATION_JOB_NAME,
    {
      taskId,
      message,
    },
    {
      jobId: buildSafeJobId(message.channel, message.messageId),
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  );

  return task;
};

export const requeueOrchestrationTask = async (
  taskId: string,
  message: NormalizedIncomingMessageDTO,
): Promise<RuntimeTaskSnapshot> => {
  const existing = runtimeTaskStore.get(taskId);
  const task =
    existing ??
    runtimeTaskStore.create({
      taskId,
      messageId: message.messageId,
      channel: message.channel,
      userId: message.userId,
      chatId: message.chatId,
      status: 'pending',
      plan: [],
    });

  await queue.add(
    ORCHESTRATION_JOB_NAME,
    {
      taskId,
      message,
    },
    {
      jobId: buildSafeJobId(message.channel, message.messageId, 'recover', taskId, Date.now()),
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  );

  return task;
};

export const getOrchestrationQueue = () => queue;
