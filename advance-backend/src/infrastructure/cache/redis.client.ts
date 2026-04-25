import Redis from 'ioredis';

let _redis: Redis | null = null;

export const getRedisClient = (url: string): Redis => {
  if (!_redis) {
    _redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    _redis.on('error', (e: Error) => {
      console.error(JSON.stringify({ level: 'error', event: 'redis.error', message: e.message }));
    });
  }
  return _redis;
};

export const disconnectRedis = async (): Promise<void> => {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
};
