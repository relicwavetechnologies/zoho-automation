import { Queue } from 'bullmq';

import config from '../../../config';
import { HttpException } from '../../../core/http-exception';
import { logger } from '../../../utils/logger';
import type { NormalizedIncomingMessageDTO } from '../../contracts';
import { taskFsm } from '../../orchestration/task-fsm';
import { runWithRetryPolicy } from '../../observability';
import { runtimeTaskStore, type RuntimeTaskSnapshot } from '../../orchestration/runtime-task.store';
import { redisConnection } from './redis.connection';
import { buildSafeJobId, isTransientQueueInfraError, sanitizeQueueName } from './queue-safety';

export const ORCHESTRATION_QUEUE_NAME = sanitizeQueueName('company-orchestration-v0');
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
  delay?: number;
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

const buildQueueAddOptions = (jobId: string, delayMs?: number): QueueAddOptions => ({
  jobId,
  attempts: 1,
  timeout: config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS,
  removeOnComplete: 500,
  removeOnFail: 500,
  ...(typeof delayMs === 'number' && delayMs > 0 ? { delay: delayMs } : {}),
});

const enqueueJobWithRetry = async (input: {
  taskId: string;
  message: NormalizedIncomingMessageDTO;
  jobId: string;
  delayMs?: number;
  queueAdd?: QueueAddFn;
}): Promise<string> => {
  const queueAdd = input.queueAdd ?? defaultQueueAdd;
  const jobOptions = buildQueueAddOptions(input.jobId, input.delayMs);
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
        return input.jobId;
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
  const companyId = message.trace?.companyId;
  if (!companyId?.trim()) {
    throw new HttpException(400, 'Company scope is required to enqueue orchestration');
  }
  const conversationKey = message.chatId;
  const taskId = await taskFsm.create({
    companyId,
    conversationKey,
    channel: message.channel,
    inputMessage: message,
  });
  const queueJobId = buildSafeJobId(message.channel, message.messageId);
  const task = runtimeTaskStore.create({
    taskId,
    queueJobId,
    messageId: message.messageId,
    channel: message.channel,
    conversationKey,
    userId: message.userId,
    chatId: message.chatId,
    companyId,
    status: 'pending',
    plan: [],
  });

  try {
    await enqueueJobWithRetry({
      taskId,
      message,
      jobId: queueJobId,
    });
  } catch (error) {
    await taskFsm.fail(taskId, error instanceof Error ? error.message : 'queue_enqueue_failed');
    throw error;
  }

  return task;
};

export const requeueOrchestrationTask = async (
  taskId: string,
  message: NormalizedIncomingMessageDTO,
  delayMs = 0,
): Promise<RuntimeTaskSnapshot> => {
  const queueJobId = buildSafeJobId(message.channel, message.messageId, 'recover', taskId, Date.now());
  const existing = runtimeTaskStore.get(taskId);
  const conversationKey = message.chatId;
  const task =
    existing ??
    runtimeTaskStore.create({
      taskId,
      queueJobId,
      messageId: message.messageId,
      channel: message.channel,
      conversationKey,
      userId: message.userId,
      chatId: message.chatId,
      companyId: message.trace?.companyId,
      status: 'pending',
      plan: [],
    });

  await taskFsm.requeue(taskId);
  if (existing) {
    runtimeTaskStore.update(taskId, {
      queueJobId,
      conversationKey,
      status: 'pending',
    });
  }

  await enqueueJobWithRetry({
    taskId,
    message,
    jobId: queueJobId,
    delayMs,
  });

  return runtimeTaskStore.get(taskId) ?? task;
};

export const getOrchestrationQueue = () => getOrchestrationQueueSingleton();

export const __test__ = {
  buildQueueAddOptions,
  enqueueJobWithRetry,
};
