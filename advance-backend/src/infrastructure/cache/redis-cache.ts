import type Redis from 'ioredis';
import type { CachePort } from '../../shared/cache';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

export class RedisCache implements CachePort {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<Result<T | null, InfraError>> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return ok(null);
      try {
        return ok(JSON.parse(raw) as T);
      } catch {
        // Corrupt cache entry — treat as miss
        return ok(null);
      }
    } catch (e) {
      return err(wrapInfra('redis', `get:${key}`, e));
    }
  }

  async set<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<Result<void, InfraError>> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('redis', `set:${key}`, e));
    }
  }

  async setNx(key: string, value: unknown, ttlSeconds: number): Promise<Result<boolean, InfraError>> {
    try {
      const result = await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
      return ok(result === 'OK');
    } catch (e) {
      return err(wrapInfra('redis', `setNx:${key}`, e));
    }
  }

  async del(key: string): Promise<Result<void, InfraError>> {
    try {
      await this.redis.del(key);
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('redis', `del:${key}`, e));
    }
  }

  async scanDel(pattern: string): Promise<Result<number, InfraError>> {
    try {
      let deleted = 0;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.redis.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
      return ok(deleted);
    } catch (e) {
      return err(wrapInfra('redis', `scanDel:${pattern}`, e));
    }
  }
}
