/**
 * Divo's single Lark SDK boundary.
 *
 * The old implementation owned token fetching and HTTP transport with fetch.
 * This adapter intentionally delegates both to the official Node SDK. Divo
 * supplies an already-authorised user token when a shared connection is used;
 * otherwise the SDK obtains and caches the installed app's tenant token.
 */
import {
  Client as LarkSdkClient,
  Domain,
  LoggerLevel,
  withUserAccessToken,
  type Client,
} from '@larksuiteoapi/node-sdk';

export interface LarkHttpClientDeps {
  appId: string;
  appSecret: string;
  /** Pre-resolved Divo connection token. It is never persisted by the SDK. */
  userToken?: string;
  /** Allows self-hosted/region-specific Lark Open API domains. */
  apiBaseUrl?: string;
  /** Test seam; production composition always uses the official SDK client. */
  sdkClient?: Pick<Client, 'request'>;
}

export class LarkApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'LarkApiError';
  }
}

type LarkEnvelope = {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;

const asCode = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Compatibility name for the existing family adapters. This is no longer an
 * HTTP client: every request is issued by `@larksuiteoapi/node-sdk`.
 */
export class LarkHttpClient {
  private readonly client: Pick<Client, 'request'>;
  private readonly userToken: string | undefined;

  constructor(deps: LarkHttpClientDeps) {
    this.userToken = deps.userToken;
    this.client = deps.sdkClient ?? new LarkSdkClient({
      appId: deps.appId,
      appSecret: deps.appSecret,
      domain: deps.apiBaseUrl?.replace(/\/$/, '') || Domain.Lark,
      loggerLevel: LoggerLevel.warn,
      source: 'divo',
    });
  }

  /**
   * Calls a documented Lark Open API route through the official SDK's
   * low-level API. Family adapters should use the SDK's semantic methods when
   * they cover an operation; this is the supported fallback for gaps.
   */
  async request<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    opts?: { query?: Record<string, string | number | string[] | undefined>; body?: unknown },
  ): Promise<T> {
    try {
      const response = await this.client.request<LarkEnvelope>({
        method,
        url: path,
        ...(opts?.query ? { params: opts.query } : {}),
        ...(opts?.query && Object.values(opts.query).some(Array.isArray)
          ? { paramsSerializer: serializeRepeatedQuery }
          : {}),
        ...(opts?.body !== undefined ? { data: opts.body } : {}),
      }, this.userToken ? withUserAccessToken(this.userToken) : undefined);

      const envelope = response as LarkEnvelope;
      const code = asCode(envelope.code);
      if (code !== undefined && code !== 0) {
        const message = envelope.msg ?? envelope.message ?? 'Lark API request failed';
        throw new LarkApiError(`${message} — ${JSON.stringify(envelope)}`, 200, code);
      }
      return (envelope.data ?? envelope) as T;
    } catch (error) {
      if (error instanceof LarkApiError) throw error;
      throw toLarkApiError(error);
    }
  }
}

function serializeRepeatedQuery(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(params)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined) query.append(key, String(value));
    }
  }
  return query.toString();
}

function toLarkApiError(error: unknown): LarkApiError {
  const candidate = asRecord(error);
  const response = asRecord(candidate?.['response']);
  const data = asRecord(response?.['data']) ?? asRecord(candidate?.['data']);
  const status = typeof response?.['status'] === 'number' ? response['status'] : 0;
  const code = asCode(data?.['code'] ?? candidate?.['code']);
  const message =
    (data?.['msg'] as string | undefined) ??
    (data?.['message'] as string | undefined) ??
    (candidate?.['message'] as string | undefined) ??
    'Lark SDK request failed';
  return new LarkApiError(message, status, code);
}
