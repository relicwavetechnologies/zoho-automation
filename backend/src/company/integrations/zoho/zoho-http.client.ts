import { Buffer } from 'buffer';

import config from '../../../config';
import {
  CircuitBreakerOpenError,
  runWithCircuitBreaker,
} from '../../observability/circuit-breaker';
import { logger } from '../../../utils/logger';
import { ZohoIntegrationError, ZohoFailureCode } from './zoho.errors';
import { zohoRateLimitService } from './zoho-rate-limit.service';

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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: URLSearchParams | FormData | Record<string, unknown>;
  retry?: RetryOptions;
};

export type ZohoRawResponse = {
  contentType?: string;
  contentDisposition?: string;
  contentLength?: number;
  contentBase64: string;
  sizeBytes: number;
};

const readRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const redactBody = (
  body: URLSearchParams | FormData | Record<string, unknown> | undefined,
): unknown => {
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

  if (body instanceof FormData) {
    return '[FORM_DATA]';
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

const ZOHO_CIRCUIT_BREAKER = {
  failureThreshold: 5,
  windowMs: 60_000,
  openMs: 120_000,
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
    this.accountsBaseUrl = (options.accountsBaseUrl ?? config.ZOHO_ACCOUNTS_BASE_URL).replace(
      /\/$/,
      '',
    );
    this.apiBaseUrl = (options.apiBaseUrl ?? config.ZOHO_API_BASE_URL).replace(/\/$/, '');
  }

  async requestJson<T>(input: RequestInput): Promise<T> {
    try {
      return await runWithCircuitBreaker(
        'zoho',
        input.base,
        {
          ...ZOHO_CIRCUIT_BREAKER,
          isFailure: (error) => (error instanceof ZohoIntegrationError ? error.retriable : true),
        },
        () => this.requestJsonInternal(input),
      );
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        throw new ZohoIntegrationError({
          message: 'Zoho is temporarily unavailable. Please try again shortly.',
          code: 'unknown',
          retriable: true,
        });
      }
      throw error;
    }
  }

  private async requestJsonInternal<T>(input: RequestInput): Promise<T> {
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
        await zohoRateLimitService.consumeCall({
          path: input.path,
          base: input.base,
        });
        const headers = new Headers(input.headers ?? {});
        let body: string | FormData | undefined;

        if (input.body instanceof URLSearchParams) {
          headers.set('Content-Type', 'application/x-www-form-urlencoded');
          body = input.body.toString();
        } else if (input.body instanceof FormData) {
          body = input.body;
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
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterMs = readRetryAfterMs(retryAfterHeader);
          const payloadMessage =
            typeof payload === 'object' &&
            payload !== null &&
            typeof (payload as { message?: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : undefined;
          const payloadCode =
            typeof payload === 'object' &&
            payload !== null &&
            typeof (payload as { code?: unknown }).code === 'string'
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

          const errorMeta = {
            url,
            method,
            statusCode: response.status,
            failureCode: classified.code,
            retriable: classified.retriable,
            retryAfterHeader,
            retryAfterMs,
            code: payloadCode,
            message: payloadMessage,
            payload:
              payload && typeof payload === 'object'
                ? payload
                : typeof payload === 'string'
                  ? payload.slice(0, 512)
                  : undefined,
          };

          if (response.status === 429) {
            logger.error('zoho.http.rate_limited', errorMeta);
          } else {
            logger.warn('zoho.http.error_response', errorMeta);
          }

          if (!error.retriable || attempt >= retryPolicy.maxAttempts) {
            throw error;
          }

          const delayMs = retryAfterMs ?? retryPolicy.baseDelayMs * attempt;
          const retryMeta = {
            url,
            method,
            attempt,
            maxAttempts: retryPolicy.maxAttempts,
            delayMs,
            statusCode: response.status,
            failureCode: classified.code,
            retryAfterHeader,
          };
          if (response.status === 429) {
            logger.error('zoho.http.rate_limit_retry', retryMeta);
          } else {
            logger.warn('zoho.http.retry', retryMeta);
          }
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
              ? ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(
                  (error as NodeJS.ErrnoException).code ?? '',
                )
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

  async requestRaw(input: RequestInput): Promise<ZohoRawResponse> {
    try {
      return await runWithCircuitBreaker(
        'zoho',
        `${input.base}:raw`,
        {
          ...ZOHO_CIRCUIT_BREAKER,
          isFailure: (error) => (error instanceof ZohoIntegrationError ? error.retriable : true),
        },
        () => this.requestRawInternal(input),
      );
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        throw new ZohoIntegrationError({
          message: 'Zoho is temporarily unavailable. Please try again shortly.',
          code: 'unknown',
          retriable: true,
        });
      }
      throw error;
    }
  }

  private async requestRawInternal(input: RequestInput): Promise<ZohoRawResponse> {
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
        await zohoRateLimitService.consumeCall({
          path: input.path,
          base: input.base,
        });
        const headers = new Headers(input.headers ?? {});
        let body: string | FormData | undefined;

        if (input.body instanceof URLSearchParams) {
          headers.set('Content-Type', 'application/x-www-form-urlencoded');
          body = input.body.toString();
        } else if (input.body instanceof FormData) {
          body = input.body;
        } else if (input.body) {
          headers.set('Content-Type', 'application/json');
          body = JSON.stringify(input.body);
        }

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body,
        });

        if (!response.ok) {
          const raw = await response.text();
          let payload: unknown = undefined;
          if (raw) {
            try {
              payload = JSON.parse(raw) as unknown;
            } catch {
              payload = raw;
            }
          }

          const classified = classifyHttpFailure(response.status);
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterMs = readRetryAfterMs(retryAfterHeader);
          const payloadMessage =
            typeof payload === 'object' &&
            payload !== null &&
            typeof (payload as { message?: unknown }).message === 'string'
              ? (payload as { message: string }).message
              : undefined;
          const payloadCode =
            typeof payload === 'object' &&
            payload !== null &&
            typeof (payload as { code?: unknown }).code === 'string'
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

          const errorMeta = {
            url,
            method,
            statusCode: response.status,
            failureCode: classified.code,
            retriable: classified.retriable,
            retryAfterHeader,
            retryAfterMs,
            code: payloadCode,
            message: payloadMessage,
            payload:
              payload && typeof payload === 'object'
                ? payload
                : typeof payload === 'string'
                  ? payload.slice(0, 512)
                  : undefined,
          };

          if (response.status === 429) {
            logger.error('zoho.http.rate_limited', errorMeta);
          } else {
            logger.warn('zoho.http.error_response', errorMeta);
          }

          if (!error.retriable || attempt >= retryPolicy.maxAttempts) {
            throw error;
          }

          const delayMs = retryAfterMs ?? retryPolicy.baseDelayMs * attempt;
          const retryMeta = {
            url,
            method,
            attempt,
            maxAttempts: retryPolicy.maxAttempts,
            delayMs,
            statusCode: response.status,
            failureCode: classified.code,
            retryAfterHeader,
          };
          if (response.status === 429) {
            logger.error('zoho.http.rate_limit_retry', retryMeta);
          } else {
            logger.warn('zoho.http.retry', retryMeta);
          }
          await sleep(delayMs);
          attempt += 1;
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          contentType: response.headers.get('content-type') ?? undefined,
          contentDisposition: response.headers.get('content-disposition') ?? undefined,
          contentLength: response.headers.get('content-length')
            ? Number(response.headers.get('content-length'))
            : undefined,
          contentBase64: buffer.toString('base64'),
          sizeBytes: buffer.byteLength,
        };
      } catch (error) {
        const retriable =
          error instanceof ZohoIntegrationError
            ? error.retriable
            : error instanceof Error
              ? ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(
                  (error as NodeJS.ErrnoException).code ?? '',
                )
              : false;

        if (!retriable || attempt >= retryPolicy.maxAttempts) {
          if (error instanceof ZohoIntegrationError) {
            throw error;
          }

          logger.warn('zoho.http.unexpected_error', {
            url,
            method,
            attempt,
            maxAttempts: retryPolicy.maxAttempts,
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
            body: redactBody(input.body),
          });
          throw new ZohoIntegrationError({
            message: error instanceof Error ? error.message : 'Unexpected Zoho HTTP error',
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
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined,
        });
        await sleep(delayMs);
        attempt += 1;
      }
    }
  }
}

export const zohoHttpClient = new ZohoHttpClient();
