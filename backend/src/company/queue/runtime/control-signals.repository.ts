import { HttpException } from '../../../core/http-exception';
import { redisConnection } from './redis.connection';

export type RuntimeControlSignal = 'running' | 'paused' | 'cancelled';

const signalKey = (taskId: string) => `company:task:${taskId}:control_signal`;
const CONTROL_SIGNAL_TTL_SECONDS = 60 * 60 * 24;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

class RuntimeControlSignalsRepository {
  async set(taskId: string, signal: RuntimeControlSignal): Promise<void> {
    const redis = redisConnection.getClient();
    await redis.set(signalKey(taskId), signal, 'EX', CONTROL_SIGNAL_TTL_SECONDS);
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

  async assertRunnableAtBoundary(taskId: string, abortSignal?: AbortSignal): Promise<void> {
    for (;;) {
      if (abortSignal?.aborted) {
        throw new HttpException(409, 'Task cancelled via abort signal');
      }
      const signal = await this.get(taskId);
      if (signal === 'cancelled') {
        throw new HttpException(409, 'Task cancelled via control signal');
      }
      if (signal === 'paused') {
        await sleep(300);
        continue;
      }
      if (abortSignal?.aborted) {
        throw new HttpException(409, 'Task cancelled via abort signal');
      }
      return;
    }
  }
}

export const runtimeControlSignalsRepository = new RuntimeControlSignalsRepository();
