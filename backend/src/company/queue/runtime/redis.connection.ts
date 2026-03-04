import IORedis from 'ioredis';

import config from '../../../config';

class RedisConnection {
  private client: IORedis | null = null;

  getClient(): IORedis {
    if (!this.client) {
      this.client = new IORedis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
      });
    }
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }
    await this.client.quit();
    this.client = null;
  }
}

export const redisConnection = new RedisConnection();
