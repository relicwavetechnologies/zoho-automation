import { cacheRedisConnection } from '../company/queue/runtime/redis.connection';

type CachedRedisToken = {
  token: string;
  expiresAtMs: number;
};

const TOKEN_TTL_BUFFER_MS = 60_000;
const POLL_INTERVAL_MS = 200;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class RedisTokenCache {
  private getClient() {
    return cacheRedisConnection.getClient();
  }

  async get(key: string): Promise<CachedRedisToken | null> {
    const raw = await this.getClient().get(key);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as CachedRedisToken;
      if (
        typeof parsed?.token !== 'string'
        || parsed.token.trim().length === 0
        || typeof parsed?.expiresAtMs !== 'number'
      ) {
        return null;
      }
      if (Date.now() >= parsed.expiresAtMs) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async set(key: string, token: string, expiresAtMs: number): Promise<void> {
    const ttlMs = expiresAtMs - Date.now() - TOKEN_TTL_BUFFER_MS;
    if (ttlMs <= 0) {
      return;
    }
    await this.getClient().set(
      key,
      JSON.stringify({ token, expiresAtMs }),
      'EX',
      Math.max(1, Math.floor(ttlMs / 1000)),
    );
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.getClient().set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async waitForToken(key: string, timeoutMs: number): Promise<CachedRedisToken | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cached = await this.get(key);
      if (cached) {
        return cached;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }
}

export const redisTokenCache = new RedisTokenCache();
