import { checkpointRepository } from '../../state/checkpoint';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';
import { logger } from '../../../utils/logger';
import { runtimeControlSignalsRepository, type RuntimeControlSignal } from './control-signals.repository';
import { enqueueOrchestrationTask, getOrchestrationQueue, requeueOrchestrationTask } from './orchestration.queue';
import {
  abortRunningTaskInProcess,
  startOrchestrationWorker,
  stopOrchestrationWorker,
} from './orchestration.worker';
import { cacheRedisConnection, queueRedisConnection, stateRedisConnection } from './redis.connection';

export const initializeOrchestrationRuntime = async (): Promise<void> => {
  try {
    await Promise.all([
      queueRedisConnection.ensureReady(),
      stateRedisConnection.ensureReady(),
      cacheRedisConnection.ensureReady(),
    ]);
  } catch (error) {
    logger.error('orchestration.runtime.init.failed', { error });
    throw error;
  }
  await startOrchestrationWorker();
};

export const shutdownOrchestrationRuntime = async (): Promise<void> => {
  await stopOrchestrationWorker();
  await Promise.all([
    queueRedisConnection.disconnect(),
    stateRedisConnection.disconnect(),
    cacheRedisConnection.disconnect(),
  ]);
};

export const orchestrationRuntime = {
  enqueue: enqueueOrchestrationTask,
  requeue: requeueOrchestrationTask,
  async cancelPendingForConversation(channel: string, chatId: string): Promise<{ cancelledCount: number }> {
    const pendingTasks = runtimeTaskStore.getPendingTasksForChat(channel, chatId);
    const queue = getOrchestrationQueue();
    let cancelledCount = 0;

    for (const task of pendingTasks) {
      try {
        if (task.queueJobId) {
          const job = await queue.getJob(task.queueJobId);
          await job?.remove();
        }
      } catch (error) {
        logger.warn('orchestration.runtime.pending_cancel.remove_failed', {
          taskId: task.taskId,
          queueJobId: task.queueJobId ?? null,
          channel,
          chatId,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      }

      await runtimeControlSignalsRepository.set(task.taskId, 'cancelled');
      runtimeTaskStore.update(task.taskId, { status: 'cancelled', controlSignal: 'cancelled' });
      cancelledCount += 1;
    }

    return { cancelledCount };
  },
  async control(taskId: string, signal: RuntimeControlSignal) {
    await runtimeControlSignalsRepository.set(taskId, signal);
    if (signal === 'cancelled') {
      abortRunningTaskInProcess(taskId);
    }
    return runtimeTaskStore.update(taskId, { controlSignal: signal });
  },
  listRecent(limit?: number) {
    return runtimeTaskStore.list(limit);
  },
  async getTask(taskId: string) {
    const task = runtimeTaskStore.get(taskId);
    if (!task) {
      return null;
    }
    const latestCheckpoint = await checkpointRepository.getLatest(taskId);
    return {
      ...task,
      latestCheckpoint,
    };
  },
};

export { getOrchestrationQueue };
