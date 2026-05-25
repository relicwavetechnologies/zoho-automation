import type { Result } from './result';
import type { InfraError } from './errors';

/** Generic cache port. Infrastructure implements this; application depends on it. */
export interface CachePort {
  get<T>(key: string): Promise<Result<T | null, InfraError>>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<Result<void, InfraError>>;
  /** Set only if key does not exist. Returns true if the key was set, false if it already existed. */
  setNx(key: string, value: unknown, ttlSeconds: number): Promise<Result<boolean, InfraError>>;
  del(key: string): Promise<Result<void, InfraError>>;
  /** Delete all keys matching a glob pattern (e.g. "perm:co:abc:*"). */
  scanDel(pattern: string): Promise<Result<number, InfraError>>;
}
