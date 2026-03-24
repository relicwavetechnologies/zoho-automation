import IORedis from 'ioredis';

import config from '../../../config';
import { logger } from '../../../utils/logger';

type RedisHealth = {
  ok: boolean;
  latencyMs?: number;
  error?: string;
};

const timeoutAfter = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis readiness timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });

class RedisConnection {
  private client: IORedis | null = null;

  private listenersAttached = false;

  constructor(
    private readonly name: 'queue' | 'state' | 'cache',
    private readonly url: string,
  ) {}

  private attachListeners(client: IORedis): void {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;

    client.on('ready', () => {
      logger.info('redis.ready', { redisRole: this.name });
    });
    client.on('reconnecting', () => {
      logger.warn('redis.reconnecting', { redisRole: this.name });
    });
    client.on('end', () => {
      logger.warn('redis.closed', { redisRole: this.name });
    });
    client.on('error', (error) => {
      logger.error('redis.error', { redisRole: this.name, error });
    });
  }

  getClient(): IORedis {
    if (!this.client) {
      logger.info('redis.connecting', { redisRole: this.name, url: this.url });
      this.client = new IORedis(this.url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
      this.attachListeners(this.client);
    }
    return this.client;
  }

  async ensureReady(timeoutMs = 3_000): Promise<void> {
    const client = this.getClient();
    const startedAt = Date.now();
    await timeoutAfter(client.ping(), timeoutMs);
    logger.info('redis.ensure_ready.ok', {
      redisRole: this.name,
      latencyMs: Date.now() - startedAt,
      status: client.status,
    });
  }

  async health(timeoutMs = 1_500): Promise<RedisHealth> {
    const client = this.getClient();
    const startedAt = Date.now();
    try {
      await timeoutAfter(client.ping(), timeoutMs);
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'redis_health_check_failed',
      };
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.quit();
    } catch (error) {
      logger.warn('redis.disconnect.failed', { redisRole: this.name, error });
    }
    this.client = null;
    this.listenersAttached = false;
  }
}

export const queueRedisConnection = new RedisConnection('queue', config.REDIS_QUEUE_URL);
export const stateRedisConnection = new RedisConnection('state', config.REDIS_STATE_URL);
export const cacheRedisConnection = new RedisConnection('cache', config.REDIS_CACHE_URL);

// Backward-compatible alias for queue-scoped runtime code.
export const redisConnection = queueRedisConnection;
