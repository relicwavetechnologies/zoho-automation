import { checkpointRepository } from '../../state/checkpoint';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';
import { logger } from '../../../utils/logger';
import { setOrchestrationQueueBackendMode, isMemoryQueueBackend } from './orchestration.backend';
import { removeInMemoryOrchestrationJob } from './in-memory-orchestration.queue';
import { runtimeControlSignalsRepository, type RuntimeControlSignal } from './control-signals.repository';
import { enqueueOrchestrationTask, getOrchestrationQueue, requeueOrchestrationTask } from './orchestration.queue';
import {
  abortRunningTaskInProcess,
  startOrchestrationWorker,
  stopOrchestrationWorker,
} from './orchestration.worker';
import { cacheRedisConnection, queueRedisConnection, stateRedisConnection } from './redis.connection';

export const initializeOrchestrationRuntime = async (): Promise<void> => {
  let usingMemoryFallback = false;
  try {
    await Promise.all([
      queueRedisConnection.ensureReady(),
      stateRedisConnection.ensureReady(),
    ]);
  } catch (error) {
    usingMemoryFallback = true;
    setOrchestrationQueueBackendMode(
      'memory',
      error instanceof Error ? error.message : 'redis_queue_or_state_unavailable',
    );
    logger.warn('orchestration.runtime.init.memory_fallback', {
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }

  if (!usingMemoryFallback) {
    setOrchestrationQueueBackendMode('redis');
    try {
      await cacheRedisConnection.ensureReady();
    } catch (error) {
      logger.error('orchestration.runtime.init.failed', { error });
      throw error;
    }
  } else {
    try {
      await cacheRedisConnection.ensureReady();
    } catch (error) {
      logger.warn('orchestration.runtime.cache.unavailable', {
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
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
    const queue = isMemoryQueueBackend() ? null : getOrchestrationQueue();
    let cancelledCount = 0;

    for (const task of pendingTasks) {
      try {
        if (task.queueJobId) {
          if (queue) {
            const job = await queue.getJob(task.queueJobId);
            await job?.remove();
          } else {
            removeInMemoryOrchestrationJob(task.queueJobId);
          }
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
