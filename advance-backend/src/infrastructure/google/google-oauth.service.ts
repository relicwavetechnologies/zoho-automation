/**
 * GoogleOAuthService — Google OAuth 2.0 token management.
 *
 * Responsibilities:
 *   1. Build consent URL (getAuthorizeUrl).
 *   2. Exchange authorization code for tokens (exchangeAuthorizationCode).
 *   3. Refresh an expired access token (refreshAccessToken).
 *   4. Get a valid access token — Redis cache → DB refresh (getValidAccessToken).
 *   5. Fetch user info from Google's OIDC endpoint (fetchUserInfo).
 *
 * Token cache:
 *   Key:  `google:token:{companyId}:{userId}`
 *   TTL:  (expiresIn - 60) seconds (60s safety buffer)
 *   Stored value: { token: string; expiresAtMs: number }
 *
 * Token exchange/refresh stays in Divo. Runtime operations receive only a
 * short-lived access token through the private Workspace MCP adapter.
 */

import type { Logger } from '../../shared/logger';
import type { CachePort } from '../../shared/cache';
import type { TypedEnv } from '../../config/env';
import { GOOGLE_WORKSPACE_OAUTH_SCOPES } from '../../domain/google/google-workspace-scope';

// ─── Constants ────────────────────────────────────────────────────────────────

const GOOGLE_AUTH_BASE_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL       = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL    = 'https://openidconnect.googleapis.com/v1/userinfo';
const TOKEN_EXPIRY_BUFFER_MS = 60_000; // 60 s buffer before actual expiry

const DEFAULT_SCOPES = GOOGLE_WORKSPACE_OAUTH_SCOPES;

// ─── Types ────────────────────────────────────────────────────────────────────

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfoResponse {
  sub?: string;
  email?: string;
  name?: string;
}

interface CachedGoogleToken {
  token:       string;
  expiresAtMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const buildCacheKey = (companyId: string, userId: string): string =>
  `google:token:${companyId}:${userId}`;

function readErrorMessage(payload: GoogleTokenResponse | null | undefined, fallback: string): string {
  const msg = payload?.error_description ?? payload?.error ?? fallback;
  return typeof msg === 'string' && msg.trim().length > 0 ? msg.trim() : fallback;
}

async function tryParseJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return {}; }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class GoogleOAuthService {
  private readonly clientId:     string;
  private readonly clientSecret: string;
  private readonly redirectUri:  string;
  private readonly log:          Logger;
  private readonly cache:        CachePort;

  constructor(opts: {
    env:    TypedEnv;
    cache:  CachePort;
    logger: Logger;
  }) {
    this.clientId     = (opts.env.GOOGLE_OAUTH_CLIENT_ID     ?? '').trim();
    this.clientSecret = (opts.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
    this.redirectUri  = this.resolveRedirectUri(opts.env);
    this.cache        = opts.cache;
    this.log          = opts.logger.child({ service: 'google-oauth' });
  }

  // ── Config helpers ───────────────────────────────────────────────────────

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  getScopes(): string[] {
    return [...DEFAULT_SCOPES];
  }

  private resolveRedirectUri(env: TypedEnv): string {
    if (env.GOOGLE_OAUTH_REDIRECT_URI?.trim()) {
      return env.GOOGLE_OAUTH_REDIRECT_URI.trim();
    }
    const base = env.BACKEND_PUBLIC_URL.trim();
    return base ? `${base.replace(/\/$/, '')}/api/desktop/auth/google/callback` : '';
  }

  // ── Consent URL ──────────────────────────────────────────────────────────

  getAuthorizeUrl(input: {
    state:        string;
    redirectUri?: string;
    scopes?:      string[];
  }): string {
    const uri = (input.redirectUri?.trim() || this.redirectUri).trim();
    if (!this.clientId || !this.clientSecret || !uri) {
      throw new Error('Google OAuth is not fully configured in env');
    }

    const scopes = (input.scopes?.length ? input.scopes : DEFAULT_SCOPES).join(' ');
    const url    = new URL(GOOGLE_AUTH_BASE_URL);
    url.searchParams.set('client_id',              this.clientId);
    url.searchParams.set('redirect_uri',           uri);
    url.searchParams.set('response_type',          'code');
    url.searchParams.set('access_type',            'offline');
    url.searchParams.set('prompt',                 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('scope',                  scopes);
    url.searchParams.set('state',                  input.state);
    return url.toString();
  }

  // ── Authorization code exchange ──────────────────────────────────────────

  async exchangeAuthorizationCode(
    code:         string,
    redirectUri?: string,
  ): Promise<{
    accessToken:  string;
    refreshToken?: string;
    tokenType?:   string;
    expiresIn?:   number;
    scope?:       string;
  }> {
    this.assertConfigured('exchangeAuthorizationCode');
    const uri = (redirectUri?.trim() || this.redirectUri).trim();

    let res: Response;
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     this.clientId,
          client_secret: this.clientSecret,
          code:          code.trim(),
          grant_type:    'authorization_code',
          redirect_uri:  uri,
        }),
      });
    } catch (e) {
      throw new Error(`Google auth code exchange network error: ${String(e)}`);
    }

    const payload = (await tryParseJson(res)) as GoogleTokenResponse;
    if (!res.ok) {
      const reason = readErrorMessage(payload, 'Google authorization code exchange failed');
      this.log.warn('google.oauth.exchange.failed', { status: res.status, reason });
      throw new Error(reason);
    }

    const accessToken = payload.access_token?.trim();
    if (!accessToken) {
      throw new Error(readErrorMessage(payload, 'Google authorization code exchange returned no access_token'));
    }

    return {
      accessToken,
      ...(payload.refresh_token?.trim() ? { refreshToken: payload.refresh_token.trim() } : {}),
      ...(payload.token_type?.trim()    ? { tokenType:    payload.token_type.trim() }    : {}),
      ...(typeof payload.expires_in === 'number' ? { expiresIn: payload.expires_in } : {}),
      ...(payload.scope?.trim()         ? { scope:        payload.scope.trim() }         : {}),
    };
  }

  // ── Access token refresh ─────────────────────────────────────────────────

  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{
    accessToken: string;
    tokenType?:  string;
    expiresIn?:  number;
    scope?:      string;
  }> {
    this.assertConfigured('refreshAccessToken');

    let res: Response;
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken.trim(),
          grant_type:    'refresh_token',
        }),
      });
    } catch (e) {
      throw new Error(`Google token refresh network error: ${String(e)}`);
    }

    const payload = (await tryParseJson(res)) as GoogleTokenResponse;
    if (!res.ok) {
      const reason = readErrorMessage(payload, 'Google access token refresh failed');
      this.log.warn('google.oauth.refresh.failed', { status: res.status, reason });
      throw new Error(reason);
    }

    const accessToken = payload.access_token?.trim();
    if (!accessToken) {
      throw new Error(readErrorMessage(payload, 'Google token refresh returned no access_token'));
    }

    return {
      accessToken,
      ...(payload.token_type?.trim()    ? { tokenType:  payload.token_type.trim() }  : {}),
      ...(typeof payload.expires_in === 'number' ? { expiresIn: payload.expires_in } : {}),
      ...(payload.scope?.trim()         ? { scope:      payload.scope.trim() }        : {}),
    };
  }

  /**
   * Get a valid access token for the given user.
   *
   * Resolution order:
   *   1. Redis cache (`google:token:{companyId}:{userId}`) — if present and not expired, return it.
   *   2. Call `refreshAccessToken(refreshToken)` and cache the result.
   */
  async getValidAccessToken(opts: {
    companyId:    string;
    userId:       string;
    refreshToken: string;
  }): Promise<string> {
    const cacheKey = buildCacheKey(opts.companyId, opts.userId);

    // ── Try cache ──────────────────────────────────────────────────────────
    const cachedResult = await this.cache.get<CachedGoogleToken>(cacheKey);
    if (cachedResult.ok && cachedResult.value) {
      const cached = cachedResult.value;
      if (typeof cached.token === 'string' && cached.token &&
          typeof cached.expiresAtMs === 'number' &&
          cached.expiresAtMs - Date.now() > TOKEN_EXPIRY_BUFFER_MS) {
        return cached.token;
      }
    }

    // ── Refresh ────────────────────────────────────────────────────────────
    const refreshed    = await this.refreshAccessToken(opts.refreshToken);
    const expiresAtMs  = Date.now() + (refreshed.expiresIn ?? 3600) * 1000;
    const ttlSeconds   = Math.max(60, Math.floor((expiresAtMs - Date.now() - TOKEN_EXPIRY_BUFFER_MS) / 1000));

    const cached: CachedGoogleToken = { token: refreshed.accessToken, expiresAtMs };
    await this.cache.set(cacheKey, cached, ttlSeconds);

    this.log.debug('google.oauth.token.refreshed', {
      companyId:   opts.companyId,
      userId:      opts.userId,
      ttlSeconds,
    });

    return refreshed.accessToken;
  }

  // ── User info ────────────────────────────────────────────────────────────

  async fetchUserInfo(
    accessToken: string,
  ): Promise<{ sub: string; email?: string; name?: string }> {
    let res: Response;
    try {
      res = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (e) {
      throw new Error(`Google userinfo network error: ${String(e)}`);
    }

    if (!res.ok) {
      this.log.warn('google.oauth.userinfo.failed', { status: res.status });
      throw new Error('Unable to resolve Google user info');
    }

    const payload = (await tryParseJson(res)) as GoogleUserInfoResponse;
    const sub     = payload.sub?.trim();
    if (!sub) {
      throw new Error('Google userinfo response missing sub field');
    }

    return {
      sub,
      ...(payload.email?.trim() ? { email: payload.email.trim() } : {}),
      ...(payload.name?.trim()  ? { name:  payload.name.trim()  } : {}),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private assertConfigured(op: string): void {
    if (!this.isConfigured()) {
      throw new Error(`Google OAuth not configured in env (${op} requires GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + redirect URI)`);
    }
  }
}
