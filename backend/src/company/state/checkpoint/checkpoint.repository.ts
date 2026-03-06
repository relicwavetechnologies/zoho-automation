import type { CheckpointDTO } from '../../contracts';
import config from '../../../config';
import { redisConnection } from '../../queue/runtime/redis.connection';
import { emitRuntimeTrace } from '../../observability';

const checkpointVersionKey = (taskId: string) => `emiac:task:${taskId}:checkpoint:version`;
const checkpointHistoryKey = (taskId: string) => `emiac:task:${taskId}:checkpoint:history`;
const checkpointLatestKey = (taskId: string) => `emiac:task:${taskId}:checkpoint:latest`;

class CheckpointRepository {
  async save(taskId: string, node: string, state: Record<string, unknown>): Promise<CheckpointDTO> {
    const redis = redisConnection.getClient();
    const version = await redis.incr(checkpointVersionKey(taskId));
    const checkpoint: CheckpointDTO = {
      taskId,
      version,
      node,
      state,
      updatedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(checkpoint);
    await redis
      .multi()
      .set(checkpointLatestKey(taskId), serialized)
      .rpush(checkpointHistoryKey(taskId), serialized)
      .expire(checkpointLatestKey(taskId), config.CHECKPOINT_TTL_SECONDS)
      .expire(checkpointHistoryKey(taskId), config.CHECKPOINT_TTL_SECONDS)
      .expire(checkpointVersionKey(taskId), config.CHECKPOINT_TTL_SECONDS)
      .exec();
    const trace = state.trace && typeof state.trace === 'object'
      ? (state.trace as Record<string, unknown>)
      : undefined;
    emitRuntimeTrace({
      event: 'orchestration.checkpoint.saved',
      level: 'info',
      taskId,
      messageId: typeof state.messageId === 'string' ? state.messageId : undefined,
      requestId: typeof trace?.requestId === 'string' ? trace.requestId : undefined,
      metadata: {
        version,
        node,
        routeIntent:
          state.route && typeof state.route === 'object' && typeof (state.route as Record<string, unknown>).intent === 'string'
            ? (state.route as Record<string, unknown>).intent
            : undefined,
      },
    });
    return checkpoint;
  }

  async getLatest(taskId: string): Promise<CheckpointDTO | null> {
    const redis = redisConnection.getClient();
    const serialized = await redis.get(checkpointLatestKey(taskId));
    if (!serialized) {
      return null;
    }
    return JSON.parse(serialized) as CheckpointDTO;
  }

  async getHistory(taskId: string, limit = 100): Promise<CheckpointDTO[]> {
    const redis = redisConnection.getClient();
    const serialized = await redis.lrange(checkpointHistoryKey(taskId), 0, Math.max(0, limit - 1));
    return serialized.map((value) => JSON.parse(value) as CheckpointDTO);
  }
}

export const checkpointRepository = new CheckpointRepository();
