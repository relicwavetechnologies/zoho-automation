const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export type RetryPolicyInput<T> = {
  maxAttempts: number;
  baseDelayMs: number;
  run: (attempt: number) => Promise<T>;
  shouldRetry: (result: T | null, error: unknown | null, attempt: number) => boolean;
  onRetry?: (attempt: number, error: unknown | null, result: T | null, delayMs: number) => void;
};

export const runWithRetryPolicy = async <T>(input: RetryPolicyInput<T>): Promise<{ result: T; attempts: number }> => {
  const maxAttempts = Math.max(1, input.maxAttempts);
  let attempt = 1;

  // Deterministic capped retries with linear backoff.
  for (;;) {
    try {
      const result = await input.run(attempt);
      const retry = attempt < maxAttempts && input.shouldRetry(result, null, attempt);
      if (!retry) {
        return { result, attempts: attempt };
      }
      const delayMs = input.baseDelayMs * attempt;
      input.onRetry?.(attempt, null, result, delayMs);
      await sleep(delayMs);
      attempt += 1;
    } catch (error) {
      const retry = attempt < maxAttempts && input.shouldRetry(null, error, attempt);
      if (!retry) {
        throw error;
      }
      const delayMs = input.baseDelayMs * attempt;
      input.onRetry?.(attempt, error, null, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
};
