import { logger } from '../../utils/logger';

type CircuitBreakerOptions = {
  failureThreshold: number;
  windowMs: number;
  openMs: number;
  isFailure?: (error: unknown) => boolean;
};

type CircuitBreakerState = {
  failures: number[];
  openUntil: number;
};

const states = new Map<string, CircuitBreakerState>();

const defaultIsFailure = () => true;

const pruneFailures = (failures: number[], now: number, windowMs: number): number[] =>
  failures.filter((timestamp) => now - timestamp <= windowMs);

const getState = (key: string): CircuitBreakerState => {
  const existing = states.get(key);
  if (existing) {
    return existing;
  }
  const next: CircuitBreakerState = {
    failures: [],
    openUntil: 0,
  };
  states.set(key, next);
  return next;
};

export class CircuitBreakerOpenError extends Error {
  readonly provider: string;

  readonly operation: string;

  readonly retryAt: number;

  constructor(provider: string, operation: string, retryAt: number) {
    super(`${provider} is temporarily unavailable`);
    this.name = 'CircuitBreakerOpenError';
    this.provider = provider;
    this.operation = operation;
    this.retryAt = retryAt;
  }
}

export const runWithCircuitBreaker = async <T>(
  provider: string,
  operation: string,
  options: CircuitBreakerOptions,
  run: () => Promise<T>,
): Promise<T> => {
  const now = Date.now();
  const key = `${provider}:${operation}`;
  const state = getState(key);
  state.failures = pruneFailures(state.failures, now, options.windowMs);

  if (state.openUntil > now) {
    throw new CircuitBreakerOpenError(provider, operation, state.openUntil);
  }

  try {
    const result = await run();
    state.failures = [];
    state.openUntil = 0;
    return result;
  } catch (error) {
    const isFailure = (options.isFailure ?? defaultIsFailure)(error);
    if (!isFailure) {
      throw error;
    }

    const failureNow = Date.now();
    state.failures = pruneFailures(state.failures, failureNow, options.windowMs);
    state.failures.push(failureNow);
    if (state.failures.length >= options.failureThreshold) {
      state.openUntil = failureNow + options.openMs;
      logger.warn('provider.circuit_breaker.opened', {
        provider,
        operation,
        failureCount: state.failures.length,
        windowMs: options.windowMs,
        openMs: options.openMs,
      });
    }
    throw error;
  }
};
