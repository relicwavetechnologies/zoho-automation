import type { Result } from './result';
import type { InfraError } from './errors';

/** Generic cache port. Infrastructure implements this; application depends on it. */
export interface CachePort {
  get<T>(key: string): Promise<Result<T | null, InfraError>>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<Result<void, InfraError>>;
  del(key: string): Promise<Result<void, InfraError>>;
  /** Delete all keys matching a glob pattern (e.g. "perm:co:abc:*"). */
  scanDel(pattern: string): Promise<Result<number, InfraError>>;
}
