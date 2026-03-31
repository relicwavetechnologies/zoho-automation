import config from '../../../config';
import { logger } from '../../../utils/logger';
import { redisTokenCache } from '../../../utils/redis-token-cache';

type LarkTokenServiceOptions = {
  apiBaseUrl?: string;
  appId?: string;
  appSecret?: string;
  staticToken?: string;
  refreshBufferMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
};

type CachedTenantToken = {
  token: string;
  expiresAtMs: number;
};

type LarkTokenPayload = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

class LarkTokenFetchError extends Error {
  readonly retriable: boolean;

  constructor(message: string, retriable: boolean) {
    super(message);
    this.retriable = retriable;
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const readMessage = (payload: unknown): string => {
  if (payload && typeof payload === 'object' && typeof (payload as { msg?: unknown }).msg === 'string') {
    return (payload as { msg: string }).msg;
  }
  return 'Unknown Lark token response';
};

const buildTokenCacheKey = (appId: string) => `lark:tenant-token:${appId}`;
const buildInflightLockKey = (appId: string) => `lark:tenant-token:${appId}:inflight`;

export class LarkTenantTokenService {
  private readonly apiBaseUrl: string;

  private readonly appId: string;

  private readonly appSecret: string;

  private readonly staticToken?: string;

  private readonly refreshBufferMs: number;

  private readonly maxRetries: number;

  private readonly retryBaseDelayMs: number;

  private readonly fetchImpl: typeof fetch;

  private readonly now: () => number;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly log: Pick<typeof logger, 'info' | 'warn' | 'error'>;

  private cached: CachedTenantToken | null = null;

  private refreshInFlight: Promise<string> | null = null;

  private loggedStaticFallback = false;

  constructor(options: LarkTokenServiceOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? config.LARK_API_BASE_URL;
    this.appId = options.appId ?? config.LARK_APP_ID;
    this.appSecret = options.appSecret ?? config.LARK_APP_SECRET;
    this.staticToken = ((options.staticToken ?? config.LARK_BOT_TENANT_ACCESS_TOKEN) || '').trim() || undefined;
    this.refreshBufferMs = Math.max(0, options.refreshBufferMs ?? config.LARK_TENANT_TOKEN_REFRESH_BUFFER_SECONDS * 1000);
    this.maxRetries = Math.max(1, options.maxRetries ?? config.LARK_TENANT_TOKEN_FETCH_MAX_RETRIES);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? config.LARK_TENANT_TOKEN_RETRY_BASE_DELAY_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? logger;
  }

  async getAccessToken(input?: { forceRefresh?: boolean }): Promise<string> {
    const forceRefresh = input?.forceRefresh === true;

    if (!forceRefresh && this.hasValidCachedToken()) {
      return this.cached!.token;
    }

    if (!forceRefresh) {
      const redisCached = await redisTokenCache.get(buildTokenCacheKey(this.appId));
      if (redisCached && this.now() + this.refreshBufferMs < redisCached.expiresAtMs) {
        this.cached = {
          token: redisCached.token,
          expiresAtMs: redisCached.expiresAtMs,
        };
        return redisCached.token;
      }
    }

    if (!this.hasAutoCredentials()) {
      return this.resolveStaticFallback('missing_app_credentials');
    }

    if (!this.refreshInFlight) {
      const lockAcquired = await redisTokenCache.acquireLock(buildInflightLockKey(this.appId), 10);
      if (!lockAcquired && !forceRefresh) {
        const waited = await redisTokenCache.waitForToken(buildTokenCacheKey(this.appId), 10_000);
        if (waited && this.now() + this.refreshBufferMs < waited.expiresAtMs) {
          this.cached = {
            token: waited.token,
            expiresAtMs: waited.expiresAtMs,
          };
          return waited.token;
        }
      }

      this.refreshInFlight = this.refreshTokenWithRetry().finally(() => {
        this.refreshInFlight = null;
      });
    }

    try {
      return await this.refreshInFlight;
    } catch (error) {
      if (this.staticToken) {
        this.log.warn('lark.tenant_token.fallback_static', {
          reason: 'token_fetch_failed',
          hasAppId: Boolean(this.appId),
          hasAppSecret: Boolean(this.appSecret),
        });
        return this.staticToken;
      }

      throw error;
    }
  }

  clearCache(): void {
    this.cached = null;
  }

  private hasAutoCredentials(): boolean {
    return this.appId.length > 0 && this.appSecret.length > 0;
  }

  private hasValidCachedToken(): boolean {
    if (!this.cached) {
      return false;
    }
    return this.now() + this.refreshBufferMs < this.cached.expiresAtMs;
  }

  private resolveStaticFallback(reason: 'missing_app_credentials'): string {
    if (this.staticToken) {
      if (!this.loggedStaticFallback) {
        this.log.warn('lark.tenant_token.static_override_enabled', {
          reason,
          hasAppId: Boolean(this.appId),
          hasAppSecret: Boolean(this.appSecret),
        });
        this.loggedStaticFallback = true;
      }
      return this.staticToken;
    }

    throw new LarkTokenFetchError(
      'Lark tenant token unavailable: configure LARK_APP_ID/LARK_APP_SECRET or LARK_BOT_TENANT_ACCESS_TOKEN',
      false,
    );
  }

  private async refreshTokenWithRetry(): Promise<string> {
    let attempt = 1;

    for (;;) {
      try {
        return await this.fetchTokenFromLark();
      } catch (error) {
        const retriable = error instanceof LarkTokenFetchError ? error.retriable : false;
        if (!retriable || attempt >= this.maxRetries) {
          this.log.error('lark.tenant_token.refresh_failed', {
            attempt,
            maxRetries: this.maxRetries,
            retriable,
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
          throw error;
        }

        const delayMs = this.retryBaseDelayMs * attempt;
        this.log.warn('lark.tenant_token.refresh_retry', {
          attempt,
          maxRetries: this.maxRetries,
          delayMs,
        });
        await this.sleep(delayMs);
        attempt += 1;
      }
    }
  }

  private async fetchTokenFromLark(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      });
    } catch (error) {
      throw new LarkTokenFetchError(
        `Lark token fetch network error: ${error instanceof Error ? error.message : 'unknown_error'}`,
        true,
      );
    }

    let payload: LarkTokenPayload = {};
    try {
      payload = (await response.json()) as LarkTokenPayload;
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new LarkTokenFetchError(
        `Lark token fetch failed with status ${response.status}: ${readMessage(payload)}`,
        response.status >= 500 || response.status === 429,
      );
    }

    if (payload.code !== 0 || !payload.tenant_access_token || typeof payload.expire !== 'number') {
      const message = `Lark token payload invalid (code=${String(payload.code)}): ${readMessage(payload)}`;
      const retriable = payload.code === 99991677 || payload.code === 99991663;
      throw new LarkTokenFetchError(message, retriable);
    }

    const expiresAtMs = this.now() + payload.expire * 1000;
    this.cached = {
      token: payload.tenant_access_token,
      expiresAtMs,
    };
    await redisTokenCache.set(buildTokenCacheKey(this.appId), payload.tenant_access_token, expiresAtMs);

    this.log.info('lark.tenant_token.refresh_success', {
      expiresInSeconds: payload.expire,
    });

    return payload.tenant_access_token;
  }
}

export const larkTenantTokenService = new LarkTenantTokenService();
