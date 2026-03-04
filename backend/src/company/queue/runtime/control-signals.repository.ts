import { HttpException } from '../../../core/http-exception';
import { redisConnection } from './redis.connection';

export type RuntimeControlSignal = 'running' | 'paused' | 'cancelled';

const signalKey = (taskId: string) => `emiac:task:${taskId}:control_signal`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

class RuntimeControlSignalsRepository {
  async set(taskId: string, signal: RuntimeControlSignal): Promise<void> {
    const redis = redisConnection.getClient();
    await redis.set(signalKey(taskId), signal);
  }

  async get(taskId: string): Promise<RuntimeControlSignal> {
    const redis = redisConnection.getClient();
    const value = await redis.get(signalKey(taskId));
    if (!value) {
      return 'running';
    }
    if (value === 'paused' || value === 'cancelled' || value === 'running') {
      return value;
    }
    return 'running';
  }

  async assertRunnableAtBoundary(taskId: string): Promise<void> {
    for (;;) {
      const signal = await this.get(taskId);
      if (signal === 'cancelled') {
        throw new HttpException(409, 'Task cancelled via control signal');
      }
      if (signal === 'paused') {
        await sleep(300);
        continue;
      }
      return;
    }
  }
}

export const runtimeControlSignalsRepository = new RuntimeControlSignalsRepository();
