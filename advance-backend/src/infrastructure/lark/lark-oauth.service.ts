/**
 * LarkOAuthService — user-level OAuth 2.0 for Lark Open Platform.
 *
 * Flow:
 *   1. getAuthorizeUrl()  → redirect user to Lark consent screen
 *   2. exchangeCode()     → exchange auth code for access + refresh tokens + user info
 *   3. refreshUserToken() → refresh expired access token using refresh token
 *   4. getValidUserToken()→ decrypt stored token, refresh if within buffer, return plaintext
 *
 * Token exchange uses an app access token as Bearer auth per Lark user auth APIs.
 * All tokens are returned as plaintext — callers are responsible for encryption before storage.
 *
 * Lark token lifetimes:
 *   - access_token:  ~7200 s  (2 h)
 *   - refresh_token: ~2592000 s (30 d)
 */

import { randomBytes } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LarkTokenResponse {
  accessToken:            string;
  refreshToken:           string | null;
  tokenType:              string;
  expiresIn:              number;         // seconds
  refreshTokenExpiresIn:  number | null;  // seconds
  larkOpenId:             string;
  larkUserId:             string | null;
  larkName:               string | null;
  larkEmail:              string | null;
  larkEnName:             string | null;
  tenantKey:              string | null;
}

export interface LarkUserInfo {
  larkOpenId:  string;
  larkUserId:  string | null;
  larkName:    string | null;
  larkEmail:   string | null;
  larkEnName:  string | null;
  tenantKey:   string | null;
  avatarUrl:   string | null;
}

interface LarkAppAccessToken {
  token:       string;
  expiresAtMs: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class LarkOAuthService {
  private appAccessToken: LarkAppAccessToken | null = null;

  constructor(
    private readonly appId:       string,
    private readonly appSecret:   string,
    private readonly redirectUri: string,
    private readonly apiBase:     string = 'https://open.larksuite.com',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.appId && this.appSecret && this.redirectUri);
  }

  // ── 1. Build authorize URL ─────────────────────────────────────────────────

  getAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      app_id:       this.appId,
      redirect_uri: this.redirectUri,
      state,
    });
    return `${this.apiBase}/open-apis/authen/v1/index?${params}`;
  }

  // ── 2. Exchange authorization code ────────────────────────────────────────

  async exchangeCode(code: string): Promise<LarkTokenResponse> {
    const appAccessToken = await this.getAppAccessToken();
    const res = await fetch(`${this.apiBase}/open-apis/authen/v1/oidc/access_token`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${appAccessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    });

    const raw = await res.json() as Record<string, unknown>;
    if (!res.ok || raw['code'] !== 0) {
      throw new Error(`Lark token exchange failed: ${raw['msg'] ?? raw['message'] ?? res.status}`);
    }

    const data = raw['data'] as Record<string, unknown>;
    return this.enrichTokenResponse(data);
  }

  // ── 3. Refresh access token ────────────────────────────────────────────────

  async refreshUserToken(refreshToken: string): Promise<LarkTokenResponse> {
    const appAccessToken = await this.getAppAccessToken();
    const res = await fetch(`${this.apiBase}/open-apis/authen/v1/oidc/refresh_access_token`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${appAccessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    const raw = await res.json() as Record<string, unknown>;
    if (!res.ok || raw['code'] !== 0) {
      throw new Error(`Lark token refresh failed: ${raw['msg'] ?? raw['message'] ?? res.status}`);
    }

    const data = raw['data'] as Record<string, unknown>;
    return this.enrichTokenResponse(data);
  }

  // ── 4. Get user info with a live user token ────────────────────────────────

  async getUserInfo(userAccessToken: string): Promise<LarkUserInfo> {
    const res = await fetch(`${this.apiBase}/open-apis/authen/v1/user_info`, {
      headers: { 'Authorization': `Bearer ${userAccessToken}` },
    });

    const raw = await res.json() as Record<string, unknown>;
    if (!res.ok || raw['code'] !== 0) {
      throw new Error(`Lark user info failed: ${raw['msg'] ?? raw['message'] ?? res.status}`);
    }

    const data = raw['data'] as Record<string, unknown>;
    return {
      larkOpenId:  String(data['open_id']          ?? ''),
      larkUserId:  (data['user_id']  as string)    ?? null,
      larkName:    (data['name']     as string)     ?? null,
      larkEmail:   ((data['enterprise_email'] ?? data['email']) as string) ?? null,
      larkEnName:  (data['en_name']  as string)    ?? null,
      tenantKey:   (data['tenant_key'] as string)  ?? null,
      avatarUrl:   (data['avatar_url'] as string)  ?? null,
    };
  }

  // ── Helper: generate a random nonce ───────────────────────────────────────

  generateNonce(): string {
    return randomBytes(24).toString('hex');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async getAppAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.appAccessToken && this.appAccessToken.expiresAtMs > now + 60_000) {
      return this.appAccessToken.token;
    }

    const res = await fetch(`${this.apiBase}/open-apis/auth/v3/app_access_token/internal`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    const raw = await res.json() as Record<string, unknown>;
    if (!res.ok || raw['code'] !== 0) {
      throw new Error(`Lark app token failed: ${raw['msg'] ?? raw['message'] ?? res.status}`);
    }

    const data = (raw['data'] ?? raw) as Record<string, unknown>;
    const token = data['app_access_token'] as string | undefined;
    if (!token) {
      throw new Error('Lark app token failed: missing app_access_token');
    }

    const expiresInSeconds = Number(data['expire'] ?? data['expires_in'] ?? 7200);
    this.appAccessToken = {
      token,
      expiresAtMs: now + expiresInSeconds * 1000,
    };
    return token;
  }

  private async enrichTokenResponse(data: Record<string, unknown>): Promise<LarkTokenResponse> {
    const parsed = this.parseTokenResponse(data);
    const userInfo = await this.getUserInfo(parsed.accessToken);

    return {
      ...parsed,
      larkOpenId: userInfo.larkOpenId || parsed.larkOpenId,
      larkUserId: userInfo.larkUserId ?? parsed.larkUserId,
      larkName:   userInfo.larkName   ?? parsed.larkName,
      larkEmail:  userInfo.larkEmail  ?? parsed.larkEmail,
      larkEnName: userInfo.larkEnName ?? parsed.larkEnName,
      tenantKey:  userInfo.tenantKey  ?? parsed.tenantKey,
    };
  }

  private parseTokenResponse(data: Record<string, unknown>): LarkTokenResponse {
    return {
      accessToken:           String(data['access_token']          ?? ''),
      refreshToken:          (data['refresh_token']  as string)   ?? null,
      tokenType:             String(data['token_type']            ?? 'Bearer'),
      expiresIn:             Number(data['expires_in']            ?? 7200),
      refreshTokenExpiresIn: data['refresh_token_expires_in'] != null || data['refresh_expires_in'] != null
        ? Number(data['refresh_token_expires_in'] ?? data['refresh_expires_in']) : null,
      larkOpenId:            String(data['open_id']              ?? ''),
      larkUserId:            (data['user_id']   as string)       ?? null,
      larkName:              (data['name']      as string)       ?? null,
      larkEmail:             ((data['enterprise_email'] ?? data['email']) as string) ?? null,
      larkEnName:            (data['en_name']   as string)       ?? null,
      tenantKey:             (data['tenant_key'] as string)      ?? null,
    };
  }
}
