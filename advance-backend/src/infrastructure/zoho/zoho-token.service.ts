/**
 * ZohoTokenService — company-level Zoho OAuth access token management.
 *
 * Token resolution order (fastest to slowest):
 *   1. In-memory cache (process-local, sub-ms)
 *   2. Redis cache (`zoho:token:{companyId}:{environment}`, shared across replicas)
 *   3. DB: check if stored access token is still valid
 *   4. Refresh: call Zoho `/oauth/v2/token` with stored refresh token, write back
 *
 * In-flight deduplication:
 *   A `Map<string, Promise<string>>` ensures concurrent callers for the same key
 *   share a single refresh request rather than hammering Zoho.
 *
 * Refresh buffer: 120 s — tokens are considered expired 2 min before actual expiry.
 *
 * API base: env.ZOHO_ACCOUNTS_BASE_URL (default: https://accounts.zoho.com)
 */

import type { Logger } from '../../shared/logger';
import type { CachePort } from '../../shared/cache';
import type { TypedEnv } from '../../config/env';
import type { ZohoConnectionRepository } from './zoho-connection.repository';
import type {
  DecryptedIntegrationConnection,
  IntegrationConnectionRepository,
  IntegrationGrantAccess,
} from '../persistence/integration-connection.repository';

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_BUFFER_MS = 120_000; // 2 min safety buffer

// ─── Types ────────────────────────────────────────────────────────────────────

interface ZohoTokenResponse {
  access_token?:             string;
  refresh_token?:            string;
  expires_in?:               number | string;
  refresh_token_expires_in?: number | string;
  api_domain?:               string;
  token_type?:               string;
  scope?:                    string;
  error?:                    string;
  error_description?:        string;
}

interface CachedZohoToken {
  token:       string;
  expiresAtMs: number;
}

interface ZohoClientCredentials {
  clientId:        string;
  clientSecret:    string;
  redirectUri?:    string;
  accountsBaseUrl: string;
}

export interface ZohoConnectionAuthContext {
  readonly accessToken: string;
  readonly accountsBaseUrl: string;
  readonly apiBaseUrl: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const connKey    = (companyId: string, env: string) => `${companyId}:${env}`;
const integrationConnKey = (connectionId: string) => `integration:${connectionId}`;
const redisKey   = (companyId: string, env: string) => `zoho:token:${companyId}:${env}`;
const integrationRedisKey = (connectionId: string) => `zoho:token:integration:${connectionId}`;

function toNumber(v: number | string | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function tryJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return {}; }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ZohoTokenService {
  /** In-memory token cache (process-local, sub-ms). */
  private readonly memCache   = new Map<string, CachedZohoToken>();
  /** In-flight refresh promises per connection key (prevents concurrent refreshes). */
  private readonly inFlight   = new Map<string, Promise<string>>();

  private readonly log: Logger;

  constructor(
    private readonly connectionRepo: ZohoConnectionRepository,
    private readonly cache:          CachePort,
    private readonly env:            TypedEnv,
    logger:                          Logger,
    private readonly integrationConnectionRepo?: IntegrationConnectionRepository,
  ) {
    this.log = logger.child({ service: 'zoho-token' });
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  isConfigured(): boolean {
    return Boolean(this.env.ZOHO_CLIENT_ID && this.env.ZOHO_CLIENT_SECRET);
  }

  async getAuthorizeConfig(companyId: string): Promise<{ clientId: string; accountsBaseUrl: string }> {
    const credentials = await this.resolveCredentials(companyId);
    return {
      clientId:        credentials.clientId,
      accountsBaseUrl: credentials.accountsBaseUrl,
    };
  }

  private get clientId():     string { return (this.env.ZOHO_CLIENT_ID     ?? '').trim(); }
  private get clientSecret(): string { return (this.env.ZOHO_CLIENT_SECRET ?? '').trim(); }
  private get accountsBase(): string { return this.env.ZOHO_ACCOUNTS_BASE_URL.trim(); }

  private envCredentials(): ZohoClientCredentials | null {
    if (!this.clientId || !this.clientSecret) return null;
    return {
      clientId:        this.clientId,
      clientSecret:    this.clientSecret,
      ...(this.env.ZOHO_REDIRECT_URI ? { redirectUri: this.env.ZOHO_REDIRECT_URI.trim() } : {}),
      accountsBaseUrl: this.accountsBase,
    };
  }

  private async resolveCredentials(companyId: string): Promise<ZohoClientCredentials> {
    const repoWithConfig = this.connectionRepo as ZohoConnectionRepository & {
      findOAuthCredentials?: ZohoConnectionRepository['findOAuthCredentials'];
    };

    if (typeof repoWithConfig.findOAuthCredentials === 'function') {
      const configResult = await repoWithConfig.findOAuthCredentials(companyId);
      if (!configResult.ok) {
        this.log.warn('zoho.oauth_config.lookup_failed', { companyId, reason: configResult.error.message });
      } else if (configResult.value) {
        const cfg = configResult.value;
        if (cfg.clientId.trim() && cfg.clientSecret.trim()) {
          return {
            clientId:        cfg.clientId.trim(),
            clientSecret:    cfg.clientSecret.trim(),
            redirectUri:     cfg.redirectUri.trim(),
            accountsBaseUrl: cfg.accountsBaseUrl.trim() || this.accountsBase,
          };
        }
      }
    }

    const envCredentials = this.envCredentials();
    if (!envCredentials) throw new Error('Zoho OAuth credentials not configured');
    return envCredentials;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get a valid access token for the company. Refreshes if needed.
   * Throws on permanent auth failure.
   */
  async getValidToken(companyId: string, environment = 'prod'): Promise<string> {
    const now = Date.now();
    const key = connKey(companyId, environment);

    // 1. In-memory cache
    const mem = this.memCache.get(key);
    if (mem && now + REFRESH_BUFFER_MS < mem.expiresAtMs) {
      return mem.token;
    }

    // 2. Redis cache
    const redisResult = await this.cache.get<CachedZohoToken>(redisKey(companyId, environment));
    if (redisResult.ok && redisResult.value) {
      const r = redisResult.value;
      if (typeof r.token === 'string' && r.token && typeof r.expiresAtMs === 'number' && now + REFRESH_BUFFER_MS < r.expiresAtMs) {
        this.memCache.set(key, r);
        return r.token;
      }
    }

    // 3. Check stored DB token
    const connResult = await this.connectionRepo.findActive(companyId, environment);
    if (!connResult.ok) throw new Error('Zoho connection lookup failed');
    const conn = connResult.value;
    if (!conn) throw new Error(`No active Zoho connection for company ${companyId}`);

    if (conn.accessToken && conn.accessTokenExpiresAt && now + REFRESH_BUFFER_MS < conn.accessTokenExpiresAt.getTime()) {
      const expiresAtMs = conn.accessTokenExpiresAt.getTime();
      await this.storeInCache(key, companyId, environment, conn.accessToken, expiresAtMs);
      return conn.accessToken;
    }

    // 4. Refresh (with in-flight deduplication)
    return this.forceRefresh(companyId, environment);
  }

  async getValidTokenForConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
  }): Promise<string> {
    return (await this.getValidConnectionAuth(input)).accessToken;
  }

  /**
   * Resolve an accessible connection's token together with its Zoho data-centre
   * endpoints. The access check intentionally happens before token-cache reads:
   * a cached token must never grant another user access to the connection.
   */
  async getValidConnectionAuth(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: IntegrationGrantAccess;
  }): Promise<ZohoConnectionAuthContext> {
    if (!this.integrationConnectionRepo) {
      throw new Error('Zoho integration connection repository not configured');
    }

    const connResult = await this.integrationConnectionRepo.findAccessibleZohoConnection(input);
    if (!connResult.ok) throw new Error('Zoho connection lookup failed');
    const conn = connResult.value;
    if (!conn) throw new Error('Zoho connection not found or access denied');

    const now = Date.now();
    const key = integrationConnKey(input.connectionId);
    const endpoints = this.resolveConnectionEndpoints(conn);

    const mem = this.memCache.get(key);
    if (mem && now + REFRESH_BUFFER_MS < mem.expiresAtMs) {
      return { accessToken: mem.token, ...endpoints };
    }

    const redisResult = await this.cache.get<CachedZohoToken>(integrationRedisKey(input.connectionId));
    if (redisResult.ok && redisResult.value) {
      const r = redisResult.value;
      if (typeof r.token === 'string' && r.token && typeof r.expiresAtMs === 'number' && now + REFRESH_BUFFER_MS < r.expiresAtMs) {
        this.memCache.set(key, r);
        return { accessToken: r.token, ...endpoints };
      }
    }

    if (conn.accessToken && conn.accessTokenExpiresAt && now + REFRESH_BUFFER_MS < conn.accessTokenExpiresAt.getTime()) {
      const expiresAtMs = conn.accessTokenExpiresAt.getTime();
      await this.storeIntegrationInCache(input.connectionId, conn.accessToken, expiresAtMs);
      return { accessToken: conn.accessToken, ...endpoints };
    }

    const accessToken = await this.forceRefreshIntegrationConnection(conn);
    return { accessToken, ...endpoints };
  }

  /** Exchange an authorization code for tokens and store them. Returns scopes + expiry. */
  async exchangeAuthorizationCode(opts: {
    companyId:         string;
    environment:       string;
    authorizationCode: string;
    redirectUri?:      string;
  }): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[]; accountsBaseUrl: string; apiDomain?: string; tokenType?: string }> {
    const credentials = await this.resolveCredentials(opts.companyId);
    const redirectUri = (opts.redirectUri ?? credentials.redirectUri ?? '').trim();

    const res = await fetch(`${credentials.accountsBaseUrl}/oauth/v2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri:  redirectUri,
        code:          opts.authorizationCode.trim(),
      }),
    });

    const payload = (await tryJson(res)) as ZohoTokenResponse;
    if (!res.ok || !payload.access_token) {
      throw new Error(payload.error_description ?? payload.error ?? 'Zoho code exchange failed');
    }

    const expiresIn = toNumber(payload.expires_in) ?? 3600;
    return {
      accessToken:  payload.access_token,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      expiresIn,
      scopes: (payload.scope ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
      accountsBaseUrl: credentials.accountsBaseUrl,
      ...(payload.api_domain ? { apiDomain: payload.api_domain } : {}),
      ...(payload.token_type ? { tokenType: payload.token_type } : {}),
    };
  }

  /** Exchange a Zoho API Console Self Client grant. Self Client has no redirect URI. */
  async exchangeSelfClientGrant(opts: {
    clientId: string;
    clientSecret: string;
    grantToken: string;
    accountsBaseUrl: string;
  }): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[]; accountsBaseUrl: string; apiDomain?: string; tokenType?: string }> {
    const accountsBaseUrl = opts.accountsBaseUrl.trim().replace(/\/$/, '');
    const res = await fetch(`${accountsBaseUrl}/oauth/v2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     opts.clientId.trim(),
        client_secret: opts.clientSecret.trim(),
        code:          opts.grantToken.trim(),
      }),
    });

    const payload = (await tryJson(res)) as ZohoTokenResponse;
    if (!res.ok || !payload.access_token) {
      throw new Error(payload.error_description ?? payload.error ?? 'Zoho Self Client grant exchange failed');
    }

    return {
      accessToken: payload.access_token,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      expiresIn: toNumber(payload.expires_in) ?? 3600,
      scopes: (payload.scope ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
      accountsBaseUrl,
      ...(payload.api_domain ? { apiDomain: payload.api_domain } : {}),
      ...(payload.token_type ? { tokenType: payload.token_type } : {}),
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private resolveConnectionEndpoints(conn: DecryptedIntegrationConnection): {
    accountsBaseUrl: string;
    apiBaseUrl: string;
  } {
    const meta = conn.tokenMetadata ?? {};
    const accountsBaseUrl = typeof meta['accountsBaseUrl'] === 'string' && meta['accountsBaseUrl'].trim()
      ? meta['accountsBaseUrl'].trim().replace(/\/$/, '')
      : this.accountsBase.replace(/\/$/, '');
    const metadataApiBase = typeof meta['apiBaseUrl'] === 'string' && meta['apiBaseUrl'].trim()
      ? meta['apiBaseUrl'].trim()
      : typeof meta['apiDomain'] === 'string' && meta['apiDomain'].trim()
        ? meta['apiDomain'].trim()
        : this.env.ZOHO_API_BASE_URL;
    return {
      accountsBaseUrl,
      apiBaseUrl: metadataApiBase.replace(/\/$/, ''),
    };
  }

  private forceRefresh(companyId: string, environment: string): Promise<string> {
    const key = connKey(companyId, environment);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.doRefresh(companyId, environment).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private forceRefreshIntegrationConnection(conn: DecryptedIntegrationConnection): Promise<string> {
    const key = integrationConnKey(conn.id);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.doRefreshIntegrationConnection(conn).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async doRefreshIntegrationConnection(conn: DecryptedIntegrationConnection): Promise<string> {
    if (!this.integrationConnectionRepo) {
      throw new Error('Zoho integration connection repository not configured');
    }
    if (!conn.refreshToken) {
      throw new Error(`Zoho connection has no refresh token for connection ${conn.id}`);
    }

    const meta = conn.tokenMetadata ?? {};
    const credentials: ZohoClientCredentials = conn.zohoClientCredentials
      ?? await this.resolveCredentials(conn.companyId);
    const accountsBaseUrl = typeof meta['accountsBaseUrl'] === 'string'
      ? meta['accountsBaseUrl']
      : credentials.accountsBaseUrl;

    let payload: ZohoTokenResponse;
    try {
      const res = await fetch(`${accountsBaseUrl}/oauth/v2/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: conn.refreshToken,
        }),
      });
      payload = (await tryJson(res)) as ZohoTokenResponse;
      if (!res.ok || !payload.access_token) {
        throw new Error(payload.error_description ?? payload.error ?? 'Zoho token refresh failed');
      }
    } catch (e) {
      this.log.error('zoho.integration_token.refresh.failed', {
        companyId: conn.companyId,
        connectionId: conn.id,
        reason: String(e),
      });
      throw e;
    }

    const expiresIn = toNumber(payload.expires_in) ?? 3600;
    const expiresAtMs = Date.now() + expiresIn * 1000;
    const accessToken = payload.access_token;
    const nextMeta: Record<string, unknown> = {
      ...meta,
      ...(payload.api_domain ? { apiDomain: payload.api_domain } : {}),
      ...(payload.token_type ? { tokenType: payload.token_type } : {}),
    };

    const update = await this.integrationConnectionRepo.updateZohoTokens({
      companyId: conn.companyId,
      connectionId: conn.id,
      accessToken,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      accessTokenExpiresAt: new Date(expiresAtMs),
      ...(payload.scope ? { scopes: payload.scope.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) } : {}),
      tokenMetadata: nextMeta,
    });
    if (!update.ok) throw new Error(update.error.message);

    await this.storeIntegrationInCache(conn.id, accessToken, expiresAtMs);
    this.log.info('zoho.integration_token.refreshed', { companyId: conn.companyId, connectionId: conn.id, expiresIn });
    return accessToken;
  }

  private async doRefresh(companyId: string, environment: string): Promise<string> {
    const connResult = await this.connectionRepo.findActive(companyId, environment);
    if (!connResult.ok) throw new Error('Zoho connection lookup failed during refresh');
    const conn = connResult.value;
    if (!conn?.refreshToken) {
      throw new Error(`Zoho connection has no refresh token for company ${companyId}`);
    }

    const credentials = await this.resolveCredentials(companyId);

    let payload: ZohoTokenResponse;
    try {
      const apiBase = conn.apiDomain ?? this.env.ZOHO_API_BASE_URL;
      void apiBase; // reserved for multi-domain routing

      const res = await fetch(`${credentials.accountsBaseUrl}/oauth/v2/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: conn.refreshToken,
        }),
      });
      payload = (await tryJson(res)) as ZohoTokenResponse;
      if (!res.ok || !payload.access_token) {
        throw new Error(payload.error_description ?? payload.error ?? 'Zoho token refresh failed');
      }
    } catch (e) {
      const code = 'token_refresh_failed';
      await this.connectionRepo.setFailureCode(companyId, environment, code);
      this.log.error('zoho.token.refresh.failed', { companyId, environment, reason: String(e) });
      throw e;
    }

    const expiresIn = toNumber(payload.expires_in) ?? 3600;
    const expiresAtMs = Date.now() + expiresIn * 1000;
    const accessToken = payload.access_token;

    // Merge tokenMetadata patch
    const existingMeta = (conn.tokenMetadata ?? {}) as Record<string, unknown>;
    const metaPatch: Record<string, unknown> = {
      ...existingMeta,
      ...(payload.api_domain  ? { apiDomain:  payload.api_domain }  : {}),
      ...(payload.token_type  ? { tokenType:  payload.token_type }  : {}),
    };

    await this.connectionRepo.updateTokens({
      companyId,
      environment,
      accessToken,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      currentRefreshCipher: conn.refreshTokenCipher ?? '',
      accessTokenExpiresAt: new Date(expiresAtMs),
      tokenMetadataPatch:   metaPatch,
    });

    await this.storeInCache(connKey(companyId, environment), companyId, environment, accessToken, expiresAtMs);

    this.log.info('zoho.token.refreshed', { companyId, environment, expiresIn });
    return accessToken;
  }

  private async storeInCache(
    key:         string,
    companyId:   string,
    environment: string,
    token:       string,
    expiresAtMs: number,
  ): Promise<void> {
    this.memCache.set(key, { token, expiresAtMs });
    const ttlSeconds = Math.max(60, Math.floor((expiresAtMs - Date.now() - REFRESH_BUFFER_MS) / 1000));
    const cached: CachedZohoToken = { token, expiresAtMs };
    await this.cache.set(redisKey(companyId, environment), cached, ttlSeconds);
  }

  private async storeIntegrationInCache(
    connectionId: string,
    token: string,
    expiresAtMs: number,
  ): Promise<void> {
    const key = integrationConnKey(connectionId);
    this.memCache.set(key, { token, expiresAtMs });
    const ttlSeconds = Math.max(60, Math.floor((expiresAtMs - Date.now() - REFRESH_BUFFER_MS) / 1000));
    const cached: CachedZohoToken = { token, expiresAtMs };
    await this.cache.set(integrationRedisKey(connectionId), cached, ttlSeconds);
  }
}
