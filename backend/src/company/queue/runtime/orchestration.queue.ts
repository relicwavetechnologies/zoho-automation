import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';

import config from '../../../config';
import { HttpException } from '../../../core/http-exception';
import { logger } from '../../../utils/logger';
import type { NormalizedIncomingMessageDTO } from '../../contracts';
import { runWithRetryPolicy } from '../../observability';
import { runtimeTaskStore, type RuntimeTaskSnapshot } from '../../orchestration/runtime-task.store';
import { redisConnection } from './redis.connection';
import { buildSafeJobId, isTransientQueueInfraError, sanitizeQueueName } from './queue-safety';

export const ORCHESTRATION_QUEUE_NAME = sanitizeQueueName('emiac-orchestration-v0');
export const ORCHESTRATION_JOB_NAME = 'orchestration.task.execute' as const;

export type OrchestrationJobData = {
  taskId: string;
  message: NormalizedIncomingMessageDTO;
};

type QueueAddOptions = {
  jobId: string;
  attempts: number;
  timeout: number;
  removeOnComplete: number;
  removeOnFail: number;
};

type QueueAddFn = (
  jobName: typeof ORCHESTRATION_JOB_NAME,
  data: OrchestrationJobData,
  opts: QueueAddOptions,
) => Promise<unknown>;

let queue: Queue<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME> | null = null;

const getOrchestrationQueueSingleton = (): Queue<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME> => {
  if (!queue) {
    queue = new Queue<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME>(ORCHESTRATION_QUEUE_NAME, {
      connection: redisConnection.getClient(),
    });
  }
  return queue;
};

const defaultQueueAdd: QueueAddFn = (jobName, data, opts) => getOrchestrationQueueSingleton().add(jobName, data, opts);

const buildQueueAddOptions = (jobId: string): QueueAddOptions => ({
  jobId,
  attempts: 1,
  timeout: config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS,
  removeOnComplete: 500,
  removeOnFail: 500,
});

const enqueueJobWithRetry = async (input: {
  taskId: string;
  message: NormalizedIncomingMessageDTO;
  jobId: string;
  queueAdd?: QueueAddFn;
}): Promise<void> => {
  const queueAdd = input.queueAdd ?? defaultQueueAdd;
  const jobOptions = buildQueueAddOptions(input.jobId);
  const trace = {
    requestId: input.message.trace?.requestId,
    taskId: input.taskId,
    messageId: input.message.messageId,
    channel: input.message.channel,
    jobId: input.jobId,
  };

  try {
    await runWithRetryPolicy<null>({
      maxAttempts: config.ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS,
      baseDelayMs: config.ORCHESTRATION_QUEUE_ADD_BASE_DELAY_MS,
      run: async () => {
        await queueAdd(ORCHESTRATION_JOB_NAME, {
          taskId: input.taskId,
          message: input.message,
        }, jobOptions);
        return null;
      },
      shouldRetry: (_result, error) => isTransientQueueInfraError(error),
      onRetry: (attempt, error, _result, delayMs) => {
        logger.warn('queue.enqueue.retry', {
          ...trace,
          attempt,
          delayMs,
          retriable: true,
          error,
        });
      },
    });
  } catch (error) {
    const retriable = isTransientQueueInfraError(error);
    logger.error('queue.enqueue.failed', {
      ...trace,
      retriable,
      error,
    });
    logger.error('queue.enqueue.unavailable', trace);
    throw new HttpException(503, 'Orchestration queue unavailable');
  }
};

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
    companyId: message.trace?.companyId,
    status: 'pending',
    plan: [],
  });

  try {
    await enqueueJobWithRetry({
      taskId,
      message,
      jobId: buildSafeJobId(message.channel, message.messageId),
    });
  } catch (error) {
    runtimeTaskStore.update(taskId, { status: 'failed' });
    throw error;
  }

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
      companyId: message.trace?.companyId,
      status: 'pending',
      plan: [],
    });

  await enqueueJobWithRetry({
    taskId,
    message,
    jobId: buildSafeJobId(message.channel, message.messageId, 'recover', taskId, Date.now()),
  });

  return task;
};

export const getOrchestrationQueue = () => getOrchestrationQueueSingleton();

export const __test__ = {
  buildQueueAddOptions,
  enqueueJobWithRetry,
};
