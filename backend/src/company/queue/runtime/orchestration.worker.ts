import { Job, Worker } from 'bullmq';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { classifyRuntimeError } from '../../observability';
import {
  buildTaskWithConfiguredEngine,
  executeTaskWithConfiguredEngine,
  getConfiguredOrchestrationEngineId,
} from '../../orchestration/engine';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';
import { checkpointRepository } from '../../state/checkpoint';
import {
  ORCHESTRATION_JOB_NAME,
  ORCHESTRATION_QUEUE_NAME,
  type OrchestrationJobData,
} from './orchestration.queue';
import { QueueTaskTimeoutError, withTaskTimeout } from './queue-safety';
import { redisConnection } from './redis.connection';

const userLocks = new Map<string, Promise<void>>();

const runPerUserDeterministically = async (userId: string, fn: () => Promise<void>): Promise<void> => {
  const previous = userLocks.get(userId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(fn)
    .finally(() => {
      if (userLocks.get(userId) === next) {
        userLocks.delete(userId);
      }
    });
  userLocks.set(userId, next);
  return next;
};

const processTask = async (job: Job<OrchestrationJobData>): Promise<void> => {
  const { taskId, message } = job.data;
  const configuredEngine = getConfiguredOrchestrationEngineId();
  logger.info('lark.runtime.job.started', {
    requestId: message.trace?.requestId,
    channel: message.channel,
    eventId: message.trace?.eventId,
    messageId: message.messageId,
    chatId: message.chatId,
    userId: message.userId,
    taskId,
    jobId: job.id,
    textHash: message.trace?.textHash,
  });
  const task = await buildTaskWithConfiguredEngine(taskId, message);

  runtimeTaskStore.update(taskId, {
    status: 'running',
    complexityLevel: task.complexityLevel,
    executionMode: task.executionMode,
    orchestratorModel: task.orchestratorModel,
    plan: task.plan,
    configuredEngine,
    engine: configuredEngine,
    engineUsed: undefined,
    rolledBackFrom: undefined,
    rollbackReasonCode: undefined,
    routeIntent: undefined,
  });

  logger.debug('orchestration.task.route', {
    taskId,
    messageId: message.messageId,
    configuredEngine,
    complexityLevel: task.complexityLevel,
    plan: task.plan,
  });

  const latestCheckpoint = await checkpointRepository.getLatest(taskId);
  const { result, configuredEngine: selectedEngine, engineUsed, rolledBackFrom, rollbackReasonCode } = await executeTaskWithConfiguredEngine({
    task,
    message,
    latestCheckpoint,
  });

  const applyExecutionResultToTask = (input: {
    taskId: string;
    result: typeof result;
    selectedEngine: typeof selectedEngine;
    engineUsed: typeof engineUsed;
    rolledBackFrom: typeof rolledBackFrom;
    rollbackReasonCode: typeof rollbackReasonCode;
  }) =>
    runtimeTaskStore.update(input.taskId, {
      status: input.result.status,
      complexityLevel: input.result.task.complexityLevel,
      executionMode: input.result.task.executionMode,
      orchestratorModel: input.result.task.orchestratorModel,
      plan: input.result.task.plan,
      currentStep: input.result.currentStep,
      latestSynthesis: input.result.latestSynthesis,
      hitlActionId: input.result.hitlAction?.actionId,
      configuredEngine: input.selectedEngine,
      engine: input.engineUsed,
      engineUsed: input.engineUsed,
      rolledBackFrom: input.rolledBackFrom,
      rollbackReasonCode: input.rollbackReasonCode,
      graphThreadId: input.result.runtimeMeta?.threadId,
      graphNode: input.result.runtimeMeta?.node,
      graphStepHistory: input.result.runtimeMeta?.stepHistory,
      routeIntent: input.result.runtimeMeta?.routeIntent,
      agentResultsHistory: [
        ...(runtimeTaskStore.get(input.taskId)?.agentResultsHistory ?? []),
        ...(input.result.agentResults ?? []),
      ],
    });

  applyExecutionResultToTask({
    taskId,
    result,
    selectedEngine,
    engineUsed,
    rolledBackFrom,
    rollbackReasonCode,
  });

  if (rolledBackFrom) {
    logger.warn('orchestration.task.engine.rollback', {
      taskId,
      messageId: message.messageId,
      configuredEngine: selectedEngine,
      engineUsed,
      rolledBackFrom,
      rollbackReasonCode,
    });
  }

  logger.success('orchestration.task.complete', {
    taskId,
    messageId: message.messageId,
    configuredEngine: selectedEngine,
    engineUsed,
    rolledBackFrom,
    rollbackReasonCode,
    status: result.status,
  });
  logger.info('lark.runtime.job.completed', {
    requestId: message.trace?.requestId,
    channel: message.channel,
    eventId: message.trace?.eventId,
    messageId: message.messageId,
    chatId: message.chatId,
    userId: message.userId,
    taskId,
    jobId: job.id,
    status: result.status,
    textHash: message.trace?.textHash,
  });
};

export const runOrchestrationJobWithSafety = async (
  job: Job<OrchestrationJobData>,
  processor: (job: Job<OrchestrationJobData>) => Promise<void> = processTask,
): Promise<void> =>
  withTaskTimeout(
    processor(job),
    config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS,
    {
      taskId: job.data.taskId,
      messageId: job.data.message.messageId,
      channel: job.data.message.channel,
      requestId: job.data.message.trace?.requestId,
      jobId: job.id,
    },
  );

const buildWorkerOptions = (connection = redisConnection.getClient()) => ({
  connection,
  concurrency: Math.max(1, config.ORCHESTRATION_WORKER_CONCURRENCY),
  lockDuration: config.ORCHESTRATION_QUEUE_LOCK_DURATION_MS,
  stalledInterval: config.ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS,
  maxStalledCount: config.ORCHESTRATION_QUEUE_MAX_STALLED_COUNT,
});

let worker: Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME> | null = null;

export const startOrchestrationWorker = (): Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME> => {
  if (worker) {
    return worker;
  }

  worker = new Worker<OrchestrationJobData, void, typeof ORCHESTRATION_JOB_NAME>(
    ORCHESTRATION_QUEUE_NAME,
    async (job) => {
      if (job.name !== ORCHESTRATION_JOB_NAME) {
        return;
      }

      await runPerUserDeterministically(job.data.message.userId, async () => {
        try {
          await runOrchestrationJobWithSafety(job);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown orchestration worker failure';
          if (message.includes('Task cancelled via control signal')) {
            runtimeTaskStore.update(job.data.taskId, { status: 'cancelled' });
            return;
          }

          runtimeTaskStore.update(job.data.taskId, { status: 'failed' });
          if (error instanceof QueueTaskTimeoutError) {
            logger.error('queue.worker.timeout', {
              taskId: job.data.taskId,
              messageId: job.data.message.messageId,
              channel: job.data.message.channel,
              requestId: job.data.message.trace?.requestId,
              jobId: job.id,
              timeoutMs: error.timeoutMs,
            });
          }
          logger.error('orchestration.task.error', {
            taskId: job.data.taskId,
            messageId: job.data.message.messageId,
            classifiedError: classifyRuntimeError(error),
          });
          throw error;
        }
      });
    },
    buildWorkerOptions(),
  );

  worker.on('completed', (job) => {
    logger.success('orchestration.worker.job.completed', { taskId: job.data.taskId, jobId: job.id });
  });
  worker.on('failed', (job, error) => {
    const classifiedError = classifyRuntimeError(error);
    logger.error('Orchestration task failed', {
      taskId: job?.data.taskId,
      jobId: job?.id,
      error: classifiedError,
    });
    logger.error('lark.runtime.job.failed', {
      requestId: job?.data.message.trace?.requestId,
      channel: job?.data.message.channel,
      eventId: job?.data.message.trace?.eventId,
      messageId: job?.data.message.messageId,
      chatId: job?.data.message.chatId,
      userId: job?.data.message.userId,
      taskId: job?.data.taskId,
      jobId: job?.id,
      textHash: job?.data.message.trace?.textHash,
      error: classifiedError,
    });
  });
  worker.on('error', (error) => {
    logger.error('queue.worker.error', { error });
  });

  return worker;
};

export const stopOrchestrationWorker = async (): Promise<void> => {
  if (!worker) {
    return;
  }
  await worker.close();
  worker = null;
};

export const __test__ = {
  buildWorkerOptions,
  applyExecutionResultToTask: (input: {
    taskId: string;
    result: {
      status: 'pending' | 'running' | 'hitl' | 'done' | 'failed' | 'cancelled';
      task: {
        complexityLevel?: 1 | 2 | 3 | 4 | 5;
        executionMode?: 'sequential' | 'parallel' | 'mixed';
        orchestratorModel?: string;
        plan: string[];
      };
      currentStep?: string;
      latestSynthesis?: string;
      hitlAction?: { actionId: string };
      runtimeMeta?: { threadId?: string; node?: string; stepHistory?: string[]; routeIntent?: string };
      agentResults?: Array<Record<string, unknown>>;
    };
    selectedEngine: 'legacy' | 'langgraph';
    engineUsed: 'legacy' | 'langgraph';
    rolledBackFrom?: 'legacy' | 'langgraph';
    rollbackReasonCode?: string;
  }) =>
    runtimeTaskStore.update(input.taskId, {
      status: input.result.status,
      complexityLevel: input.result.task.complexityLevel,
      executionMode: input.result.task.executionMode,
      orchestratorModel: input.result.task.orchestratorModel,
      plan: input.result.task.plan,
      currentStep: input.result.currentStep,
      latestSynthesis: input.result.latestSynthesis,
      hitlActionId: input.result.hitlAction?.actionId,
      configuredEngine: input.selectedEngine,
      engine: input.engineUsed,
      engineUsed: input.engineUsed,
      rolledBackFrom: input.rolledBackFrom,
      rollbackReasonCode: input.rollbackReasonCode,
      graphThreadId: input.result.runtimeMeta?.threadId,
      graphNode: input.result.runtimeMeta?.node,
      graphStepHistory: input.result.runtimeMeta?.stepHistory,
      routeIntent: input.result.runtimeMeta?.routeIntent,
      agentResultsHistory: [
        ...(runtimeTaskStore.get(input.taskId)?.agentResultsHistory ?? []),
        ...((input.result.agentResults as any[]) ?? []),
      ],
    }),
};
