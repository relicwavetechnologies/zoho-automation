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
  const task = await buildTaskWithConfiguredEngine(taskId, message);

  runtimeTaskStore.update(taskId, {
    status: 'running',
    complexityLevel: task.complexityLevel,
    executionMode: task.executionMode,
    orchestratorModel: task.orchestratorModel,
    plan: task.plan,
    engine: configuredEngine,
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
  const { result, engineUsed, rolledBackFrom } = await executeTaskWithConfiguredEngine({
    task,
    message,
    latestCheckpoint,
  });

  runtimeTaskStore.update(taskId, {
    status: result.status,
    complexityLevel: result.task.complexityLevel,
    executionMode: result.task.executionMode,
    orchestratorModel: result.task.orchestratorModel,
    plan: result.task.plan,
    currentStep: result.currentStep,
    latestSynthesis: result.latestSynthesis,
    hitlActionId: result.hitlAction?.actionId,
    engine: engineUsed,
    graphThreadId: result.runtimeMeta?.threadId,
    graphNode: result.runtimeMeta?.node,
    graphStepHistory: result.runtimeMeta?.stepHistory,
    routeIntent: result.runtimeMeta?.routeIntent,
    agentResultsHistory: [
      ...(runtimeTaskStore.get(taskId)?.agentResultsHistory ?? []),
      ...(result.agentResults ?? []),
    ],
  });

  if (rolledBackFrom) {
    logger.warn('orchestration.task.engine.rollback', {
      taskId,
      messageId: message.messageId,
      configuredEngine: rolledBackFrom,
      engineUsed,
    });
  }

  logger.success('orchestration.task.complete', {
    taskId,
    messageId: message.messageId,
    configuredEngine,
    engineUsed,
    status: result.status,
  });
};

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
          await processTask(job);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown orchestration worker failure';
          if (message.includes('Task cancelled via control signal')) {
            runtimeTaskStore.update(job.data.taskId, { status: 'cancelled' });
            return;
          }

          runtimeTaskStore.update(job.data.taskId, { status: 'failed' });
          logger.error('orchestration.task.error', {
            taskId: job.data.taskId,
            messageId: job.data.message.messageId,
            classifiedError: classifyRuntimeError(error),
          });
          throw error;
        }
      });
    },
    {
      connection: redisConnection.getClient(),
      concurrency: Math.max(1, config.ORCHESTRATION_WORKER_CONCURRENCY),
    },
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
