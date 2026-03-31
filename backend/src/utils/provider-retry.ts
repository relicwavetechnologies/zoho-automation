export type RetryableProvider = 'zoho' | 'lark' | 'google' | 'groq' | 'openai' | 'anthropic';

export interface ProviderRetryConfig {
  provider: RetryableProvider;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: Array<'429' | '5xx' | 'network' | 'timeout'>;
  honorRetryAfter: boolean;
}

const PROVIDER_DEFAULTS: Record<RetryableProvider, ProviderRetryConfig> = {
  zoho: { provider: 'zoho', maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 10_000, retryOn: ['429', '5xx', 'network'], honorRetryAfter: true },
  lark: { provider: 'lark', maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 15_000, retryOn: ['429', '5xx', 'network'], honorRetryAfter: false },
  google: { provider: 'google', maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 20_000, retryOn: ['429', '5xx', 'network'], honorRetryAfter: true },
  groq: { provider: 'groq', maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 3_000, retryOn: ['429', '5xx', 'network'], honorRetryAfter: true },
  openai: { provider: 'openai', maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 10_000, retryOn: ['429', '5xx'], honorRetryAfter: true },
  anthropic: { provider: 'anthropic', maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 10_000, retryOn: ['429', '5xx'], honorRetryAfter: true },
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isRetryableStatus(
  status: number,
  retryOn: ProviderRetryConfig['retryOn'],
): boolean {
  if (retryOn.includes('429') && status === 429) return true;
  if (retryOn.includes('5xx') && status >= 500 && status < 600) return true;
  return false;
}

function isRetryableError(
  err: unknown,
  retryOn: ProviderRetryConfig['retryOn'],
): boolean {
  if (!retryOn.includes('network') && !retryOn.includes('timeout')) return false;
  if (!(err instanceof Error)) return false;

  const msg = err.message.toLowerCase();
  if (retryOn.includes('timeout') && (msg.includes('timeout') || msg.includes('timed out'))) {
    return true;
  }
  if (retryOn.includes('network') && (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up')
  )) {
    return true;
  }
  return false;
}

function getRetryAfterMs(headers: Record<string, string | string[] | undefined>): number | null {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

function computeDelay(attempt: number, config: ProviderRetryConfig): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * config.baseDelayMs * 0.3;
  return Math.min(exponential + jitter, config.maxDelayMs);
}

export async function withProviderRetry<T>(
  provider: RetryableProvider,
  fn: () => Promise<T>,
  overrides?: Partial<ProviderRetryConfig>,
): Promise<T> {
  const config = { ...PROVIDER_DEFAULTS[provider], ...overrides };
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      const status: number | undefined = (err as any)?.status ?? (err as any)?.response?.status;
      const headers: Record<string, string | string[] | undefined> =
        (err as any)?.headers ?? (err as any)?.response?.headers ?? {};

      const shouldRetryStatus = status !== undefined && isRetryableStatus(status, config.retryOn);
      const shouldRetryError = isRetryableError(err, config.retryOn);

      if (!shouldRetryStatus && !shouldRetryError) {
        throw err;
      }
      if (attempt === config.maxAttempts) {
        break;
      }

      let delayMs = computeDelay(attempt, config);
      if (config.honorRetryAfter && status === 429) {
        const retryAfterMs = getRetryAfterMs(headers);
        if (retryAfterMs !== null) {
          delayMs = Math.min(retryAfterMs, config.maxDelayMs);
        }
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}
