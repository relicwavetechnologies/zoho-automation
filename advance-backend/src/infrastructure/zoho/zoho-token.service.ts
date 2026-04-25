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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const connKey    = (companyId: string, env: string) => `${companyId}:${env}`;
const redisKey   = (companyId: string, env: string) => `zoho:token:${companyId}:${env}`;

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
  ) {
    this.log = logger.child({ service: 'zoho-token' });
  }

  // ── Credentials ──────────────────────────────────────────────────────────

  isConfigured(): boolean {
    return Boolean(this.env.ZOHO_CLIENT_ID && this.env.ZOHO_CLIENT_SECRET);
  }

  private get clientId():     string { return (this.env.ZOHO_CLIENT_ID     ?? '').trim(); }
  private get clientSecret(): string { return (this.env.ZOHO_CLIENT_SECRET ?? '').trim(); }
  private get accountsBase(): string { return this.env.ZOHO_ACCOUNTS_BASE_URL.trim(); }

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

  /** Exchange an authorization code for tokens and store them. Returns scopes + expiry. */
  async exchangeAuthorizationCode(opts: {
    companyId:         string;
    environment:       string;
    authorizationCode: string;
    redirectUri?:      string;
  }): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[] }> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Zoho OAuth credentials not configured');
    }
    const redirectUri = (opts.redirectUri ?? this.env.ZOHO_REDIRECT_URI ?? '').trim();

    const res = await fetch(`${this.accountsBase}/oauth/v2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     this.clientId,
        client_secret: this.clientSecret,
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
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

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

  private async doRefresh(companyId: string, environment: string): Promise<string> {
    const connResult = await this.connectionRepo.findActive(companyId, environment);
    if (!connResult.ok) throw new Error('Zoho connection lookup failed during refresh');
    const conn = connResult.value;
    if (!conn?.refreshToken) {
      throw new Error(`Zoho connection has no refresh token for company ${companyId}`);
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('Zoho client credentials not configured');
    }

    let payload: ZohoTokenResponse;
    try {
      const apiBase = conn.apiDomain ?? this.env.ZOHO_API_BASE_URL;
      void apiBase; // reserved for multi-domain routing

      const res = await fetch(`${this.accountsBase}/oauth/v2/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     this.clientId,
          client_secret: this.clientSecret,
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
      currentRefreshCipher: '', // repo will use new if provided, else keep old
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
}
