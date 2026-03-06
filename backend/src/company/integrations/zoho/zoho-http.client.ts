import config from '../../../config';
import { logger } from '../../../utils/logger';
import { ZohoIntegrationError, ZohoFailureCode } from './zoho.errors';

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
};

type ZohoHttpClientOptions = {
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
  accountsBaseUrl?: string;
  apiBaseUrl?: string;
};

type RequestInput = {
  base: 'accounts' | 'api';
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: URLSearchParams | Record<string, unknown>;
  retry?: RetryOptions;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const redactBody = (body: URLSearchParams | Record<string, unknown> | undefined): unknown => {
  if (!body) {
    return undefined;
  }

  if (body instanceof URLSearchParams) {
    const clone = new URLSearchParams(body.toString());
    ['code', 'refresh_token', 'client_secret', 'access_token'].forEach((key) => {
      if (clone.has(key)) {
        clone.set(key, '[REDACTED]');
      }
    });

    return Object.fromEntries(clone.entries());
  }

  const next: Record<string, unknown> = { ...body };
  ['code', 'refresh_token', 'client_secret', 'access_token'].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      next[key] = '[REDACTED]';
    }
  });

  return next;
};

const classifyHttpFailure = (status: number): { code: ZohoFailureCode; retriable: boolean } => {
  if (status === 429) {
    return { code: 'rate_limited', retriable: true };
  }

  if (status === 401 || status === 403) {
    return { code: 'auth_failed', retriable: false };
  }

  if (status >= 500) {
    return { code: 'unknown', retriable: true };
  }

  return { code: 'unknown', retriable: false };
};

export class ZohoHttpClient {
  private readonly fetchImpl: typeof fetch;

  private readonly retry: Required<RetryOptions>;

  private readonly accountsBaseUrl: string;

  private readonly apiBaseUrl: string;

  constructor(options: ZohoHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retry = {
      maxAttempts: Math.max(1, options.retry?.maxAttempts ?? 3),
      baseDelayMs: Math.max(0, options.retry?.baseDelayMs ?? 250),
    };
    this.accountsBaseUrl = (options.accountsBaseUrl ?? config.ZOHO_ACCOUNTS_BASE_URL).replace(/\/$/, '');
    this.apiBaseUrl = (options.apiBaseUrl ?? config.ZOHO_API_BASE_URL).replace(/\/$/, '');
  }

  async requestJson<T>(input: RequestInput): Promise<T> {
    const retryPolicy = {
      maxAttempts: Math.max(1, input.retry?.maxAttempts ?? this.retry.maxAttempts),
      baseDelayMs: Math.max(0, input.retry?.baseDelayMs ?? this.retry.baseDelayMs),
    };

    const baseUrl = input.base === 'accounts' ? this.accountsBaseUrl : this.apiBaseUrl;
    const method = input.method ?? 'GET';
    const url = `${baseUrl}${input.path}`;
    let attempt = 1;

    for (;;) {
      try {
        const headers = new Headers(input.headers ?? {});
        let body: string | undefined;

        if (input.body instanceof URLSearchParams) {
          headers.set('Content-Type', 'application/x-www-form-urlencoded');
          body = input.body.toString();
        } else if (input.body) {
          headers.set('Content-Type', 'application/json');
          body = JSON.stringify(input.body);
        }

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body,
        });

        const raw = await response.text();
        let payload: unknown = undefined;
        if (raw) {
          try {
            payload = JSON.parse(raw) as unknown;
          } catch {
            payload = raw;
          }
        }

        if (!response.ok) {
          const classified = classifyHttpFailure(response.status);
          const payloadMessage =
            typeof payload === 'object' && payload !== null && typeof (payload as { message?: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : undefined;
          const payloadCode =
            typeof payload === 'object' && payload !== null && typeof (payload as { code?: unknown }).code === 'string'
              ? (payload as { code: string }).code
              : undefined;
          const message = payloadMessage
            ? `${payloadMessage}${payloadCode ? ` [${payloadCode}]` : ''}`
            : `Zoho API request failed (${response.status})${payloadCode ? ` [${payloadCode}]` : ''}`;
          const error = new ZohoIntegrationError({
            message,
            code: classified.code,
            retriable: classified.retriable,
            statusCode: response.status,
          });

          logger.warn('zoho.http.error_response', {
            url,
            method,
            statusCode: response.status,
            code: payloadCode,
            message: payloadMessage,
            payload:
              payload && typeof payload === 'object'
                ? payload
                : typeof payload === 'string'
                  ? payload.slice(0, 512)
                  : undefined,
          });

          if (!error.retriable || attempt >= retryPolicy.maxAttempts) {
            throw error;
          }

          const delayMs = retryPolicy.baseDelayMs * attempt;
          logger.warn('zoho.http.retry', {
            url,
            method,
            attempt,
            maxAttempts: retryPolicy.maxAttempts,
            delayMs,
            statusCode: response.status,
          });
          await sleep(delayMs);
          attempt += 1;
          continue;
        }

        return (payload ?? {}) as T;
      } catch (error) {
        const retriable =
          error instanceof ZohoIntegrationError
            ? error.retriable
            : error instanceof Error
              ? ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes((error as NodeJS.ErrnoException).code ?? '')
              : false;

        if (!retriable || attempt >= retryPolicy.maxAttempts) {
          if (error instanceof ZohoIntegrationError) {
            throw error;
          }

          throw new ZohoIntegrationError({
            message: error instanceof Error ? error.message : 'Zoho network request failed',
            code: 'unknown',
            retriable,
          });
        }

        const delayMs = retryPolicy.baseDelayMs * attempt;
        logger.warn('zoho.http.retry', {
          url,
          method,
          attempt,
          maxAttempts: retryPolicy.maxAttempts,
          delayMs,
          body: redactBody(input.body),
        });
        await sleep(delayMs);
        attempt += 1;
      }
    }
  }
}

export const zohoHttpClient = new ZohoHttpClient();
