import type { Logger } from './logger';

interface CircuitBreakerOptions {
  failureThreshold: number;
  windowMs:         number;
  openMs:           number;
  isFailure?:       (error: unknown) => boolean;
}

interface CircuitBreakerState {
  failures:  number[];
  openUntil: number;
}

const states = new Map<string, CircuitBreakerState>();

const pruneFailures = (failures: number[], now: number, windowMs: number): number[] =>
  failures.filter(ts => now - ts <= windowMs);

const getState = (key: string): CircuitBreakerState => {
  let state = states.get(key);
  if (!state) {
    state = { failures: [], openUntil: 0 };
    states.set(key, state);
  }
  return state;
};

export class CircuitBreakerOpenError extends Error {
  readonly provider:  string;
  readonly operation: string;
  readonly retryAt:   number;

  constructor(provider: string, operation: string, retryAt: number) {
    super(`${provider} is temporarily unavailable`);
    this.name      = 'CircuitBreakerOpenError';
    this.provider  = provider;
    this.operation = operation;
    this.retryAt   = retryAt;
  }
}

// AbortError / TimeoutError are our own imposed limits, not provider failures.
const defaultIsFailure = (e: unknown): boolean => {
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) return false;
  return true;
};

export const runWithCircuitBreaker = async <T>(
  provider:  string,
  operation: string,
  options:   CircuitBreakerOptions,
  run:       () => Promise<T>,
  log?:      Logger,
): Promise<T> => {
  const now   = Date.now();
  const key   = `${provider}:${operation}`;
  const state = getState(key);
  state.failures = pruneFailures(state.failures, now, options.windowMs);

  if (state.openUntil > now) {
    throw new CircuitBreakerOpenError(provider, operation, state.openUntil);
  }

  try {
    const result = await run();
    // successful call resets counters
    state.failures  = [];
    state.openUntil = 0;
    return result;
  } catch (error) {
    const isFailure = (options.isFailure ?? defaultIsFailure)(error);
    if (!isFailure) throw error;

    const failAt   = Date.now();
    state.failures = pruneFailures(state.failures, failAt, options.windowMs);
    state.failures.push(failAt);

    if (state.failures.length >= options.failureThreshold) {
      state.openUntil = failAt + options.openMs;
      log?.warn('circuit_breaker.opened', {
        provider,
        operation,
        failureCount: state.failures.length,
        windowMs:     options.windowMs,
        openMs:       options.openMs,
      });
    }
    throw error;
  }
};

/** Default options matching the plan: 5 failures / 60 s window / 120 s open */
export const GEMINI_CIRCUIT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  windowMs:         60_000,
  openMs:           120_000,
};
