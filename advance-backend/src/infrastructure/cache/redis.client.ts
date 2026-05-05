import Redis from 'ioredis';

// URL-keyed registry so each distinct URL gets exactly one connection.
// Calling getRedisClient with the same URL twice returns the same instance.
const _clients = new Map<string, Redis>();

export const getRedisClient = (url: string): Redis => {
  const existing = _clients.get(url);
  if (existing) return existing;

  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (e: Error) => {
    console.error(JSON.stringify({ level: 'error', event: 'redis.error', message: e.message }));
  });
  _clients.set(url, client);
  return client;
};

/** Disconnect a specific Redis client by the URL it was created with. */
export const disconnectRedis = async (url: string): Promise<void> => {
  const client = _clients.get(url);
  if (client) {
    await client.quit();
    _clients.delete(url);
  }
};

/** Disconnect ALL Redis clients (useful in tests). */
export const disconnectAllRedis = async (): Promise<void> => {
  await Promise.all([..._clients.values()].map(c => c.quit()));
  _clients.clear();
};
