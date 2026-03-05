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

  private attachListeners(client: IORedis): void {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;

    client.on('ready', () => {
      logger.info('redis.ready');
    });
    client.on('reconnecting', () => {
      logger.warn('redis.reconnecting');
    });
    client.on('end', () => {
      logger.warn('redis.closed');
    });
    client.on('error', (error) => {
      logger.error('redis.error', { error });
    });
  }

  getClient(): IORedis {
    if (!this.client) {
      logger.info('redis.connecting', { url: config.REDIS_URL });
      this.client = new IORedis(config.REDIS_URL, {
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
      logger.warn('redis.disconnect.failed', { error });
    }
    this.client = null;
    this.listenersAttached = false;
  }
}

export const redisConnection = new RedisConnection();
