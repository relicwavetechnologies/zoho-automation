import config from '../../../config';
import { redisConnection } from '../../queue/runtime/redis.connection';

export class IdempotencyRepository {
  async claimIngressMessageId(channel: string, messageId: string): Promise<boolean> {
    const redis = redisConnection.getClient();
    const key = `emiac:idempotent:${channel}:${messageId}`;
    const result = await redis.set(key, '1', 'EX', config.INGRESS_IDEMPOTENCY_TTL_SECONDS, 'NX');
    return result === 'OK';
  }
}

export const idempotencyRepository = new IdempotencyRepository();
