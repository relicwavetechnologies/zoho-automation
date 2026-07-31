import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';

/** One fixed-window budget. Keys are opaque and are owned by the policy service. */
export interface RateLimitWindow {
  readonly key: string;
  readonly limit: number;
  readonly ttlSeconds: number;
}

export interface RateLimitWindowState extends RateLimitWindow {
  readonly used: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimitCheck {
  readonly allowed: boolean;
  readonly windows: readonly RateLimitWindowState[];
}

/**
 * The store must make consume atomic across every supplied window. A caller
 * commonly supplies both the per-minute and per-day budget for one request.
 */
export interface RateLimitStore {
  inspect(windows: readonly RateLimitWindow[]): Promise<Result<RateLimitCheck, InfraError>>;
  consume(windows: readonly RateLimitWindow[]): Promise<Result<RateLimitCheck, InfraError>>;
}
