import { checkpointRepository } from '../../state/checkpoint';
import { runtimeTaskStore } from '../../orchestration/runtime-task.store';
import { runtimeControlSignalsRepository, type RuntimeControlSignal } from './control-signals.repository';
import { enqueueOrchestrationTask, requeueOrchestrationTask } from './orchestration.queue';
import { startOrchestrationWorker, stopOrchestrationWorker } from './orchestration.worker';
import { redisConnection } from './redis.connection';

export const initializeOrchestrationRuntime = async (): Promise<void> => {
  startOrchestrationWorker();
};

export const shutdownOrchestrationRuntime = async (): Promise<void> => {
  await stopOrchestrationWorker();
  await redisConnection.disconnect();
};

export const orchestrationRuntime = {
  enqueue: enqueueOrchestrationTask,
  requeue: requeueOrchestrationTask,
  async control(taskId: string, signal: RuntimeControlSignal) {
    await runtimeControlSignalsRepository.set(taskId, signal);
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
