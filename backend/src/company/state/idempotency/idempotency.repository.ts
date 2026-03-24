import config from '../../../config';
import { stateRedisConnection } from '../../queue/runtime/redis.connection';

export type IngressIdempotencyKeyType = 'event' | 'message';

export class IdempotencyRepository {
  async claimIngressKey(channel: string, keyType: IngressIdempotencyKeyType, key: string): Promise<boolean> {
    const redis = stateRedisConnection.getClient();
    const scopedKey = `company:idempotent:${channel}:${keyType}:${key}`;
    const result = await redis.set(scopedKey, '1', 'EX', config.INGRESS_IDEMPOTENCY_TTL_SECONDS, 'NX');
    return result === 'OK';
  }

  async claimIngressMessageId(channel: string, messageId: string): Promise<boolean> {
    return this.claimIngressKey(channel, 'message', messageId);
  }
}

export const idempotencyRepository = new IdempotencyRepository();
