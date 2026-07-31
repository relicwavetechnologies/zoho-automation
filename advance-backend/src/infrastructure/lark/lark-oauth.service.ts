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
import {
  Client as LarkSdkClient,
  Domain,
  LoggerLevel,
  withUserAccessToken,
} from '@larksuiteoapi/node-sdk';

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
  scope:                  string | null;
  avatarUrl:              string | null;
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

/**
 * Scopes requested in every Divo Lark user-consent flow. They must also be
 * enabled and published in Lark Developer Console; declaring them here makes
 * the OAuth grant explicit instead of depending on console defaults.
 */
export const LARK_USER_OAUTH_SCOPES = [
  'auth:user.id:read',
  'calendar:calendar.event:create',
  'calendar:calendar.event:delete',
  'calendar:calendar.event:read',
  'calendar:calendar.event:update',
  'calendar:calendar.free_busy:read',
  'calendar:calendar:read',
  'bitable:app',
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'contact:user.email:readonly',
  'contact:user.employee:readonly',
  'contact:user:search',
  'docx:document',
  'drive:drive',
  'im:chat:read',
  'im:message',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:message.send_as_user',
  'im:message:readonly',
  'task:task:read',
  'task:task:write',
  'task:tasklist:read',
  'task:tasklist:write',
  'vc:meeting.search:read',
  'vc:meeting.meetingevent:read',
  'vc:record:readonly',
  'offline_access',
] as const;

function firstNonBlankString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class LarkOAuthService {
  private readonly client: LarkSdkClient;

  constructor(
    private readonly appId:       string,
    private readonly appSecret:   string,
    private readonly redirectUri: string,
    private readonly apiBase:     string = 'https://open.larksuite.com',
    /** Test seam; production composition always constructs the official SDK client. */
    sdkClient?: LarkSdkClient,
  ) {
    this.client = sdkClient ?? new LarkSdkClient({
      appId,
      appSecret,
      domain: apiBase.replace(/\/$/, '') || Domain.Lark,
      oauthBaseUrl: this.authBase(),
      loggerLevel: LoggerLevel.warn,
      source: 'divo',
    });
  }

  isConfigured(): boolean {
    return Boolean(this.appId && this.appSecret && this.redirectUri);
  }

  // ── 1. Build authorize URL ─────────────────────────────────────────────────

  getAuthorizeUrl(state: string, opts?: { redirectUri?: string; scopes?: readonly string[] }): string {
    const params = new URLSearchParams({
      client_id:    this.appId,
      redirect_uri: opts?.redirectUri ?? this.redirectUri,
      state,
    });
    const scopes = opts?.scopes ?? LARK_USER_OAUTH_SCOPES;
    if (scopes.length > 0) params.set('scope', scopes.join(' '));
    return `${this.authBase()}/open-apis/authen/v1/authorize?${params}`;
  }

  // ── 2. Exchange authorization code ────────────────────────────────────────

  async exchangeCode(code: string, redirectUri: string = this.redirectUri): Promise<LarkTokenResponse> {
    const token = await this.client.accessToken.retrieveByAuthorizationCode({
      code,
      redirectUri,
    });
    return this.enrichTokenResponse({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
      refresh_token_expires_in: token.refreshTokenExpiresIn,
      scope: token.scope,
    });
  }

  // ── 3. Refresh access token ────────────────────────────────────────────────

  async refreshUserToken(refreshToken: string): Promise<LarkTokenResponse> {
    const token = await this.client.accessToken.refresh({ refreshToken });
    return this.enrichTokenResponse({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
      refresh_token_expires_in: token.refreshTokenExpiresIn,
      scope: token.scope,
    });
  }

  // ── 4. Get user info with a live user token ────────────────────────────────

  async getUserInfo(userAccessToken: string): Promise<LarkUserInfo> {
    const response = await this.client.authen.userInfo.get({}, withUserAccessToken(userAccessToken));
    this.assertSuccess(response, 'Lark user info failed');
    const data = response.data ?? {};
    return {
      larkOpenId:  String(data.open_id ?? ''),
      larkUserId:  data.user_id ?? null,
      larkName:    data.name ?? null,
      // Lark commonly includes enterprise_email as an empty string while the
      // ordinary email field is populated. Nullish coalescing would discard the
      // valid fallback, so select the first non-blank value instead.
      larkEmail:   firstNonBlankString(data.enterprise_email, data.email),
      larkEnName:  data.en_name ?? null,
      tenantKey:   data.tenant_key ?? null,
      avatarUrl:   data.avatar_url ?? null,
    };
  }

  async fetchUserEmailByOpenId(openId: string, userAccessToken: string): Promise<string | null> {
    try {
      const response = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      }, withUserAccessToken(userAccessToken));
      if (response.code !== undefined && response.code !== 0) return null;
      return firstNonBlankString(
        response.data?.user?.enterprise_email,
        response.data?.user?.email,
      );
    } catch {
      return null;
    }
  }

  generateNonce(): string {
    return randomBytes(24).toString('hex');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private authBase(): string {
    if (this.apiBase.includes('open.feishu.cn')) return 'https://accounts.feishu.cn';
    if (this.apiBase.includes('open.larksuite.com')) return 'https://accounts.larksuite.com';
    return this.apiBase.replace(/\/$/, '');
  }

  private assertSuccess(response: { code?: number | undefined; msg?: string | undefined }, prefix: string): void {
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`${prefix}: ${response.msg ?? response.code}`);
    }
  }

  private async enrichTokenResponse(data: Record<string, unknown>): Promise<LarkTokenResponse> {
    const parsed = this.parseTokenResponse(data);
    const userInfo = await this.getUserInfo(parsed.accessToken);
    // The OAuth profile endpoint can legitimately omit email even when the
    // approved contact:user.email:readonly scope is present. Resolve it with
    // the official Contacts endpoint before treating the identity as incomplete.
    const contactEmail = !userInfo.larkEmail && userInfo.larkOpenId
      ? await this.fetchUserEmailByOpenId(userInfo.larkOpenId, parsed.accessToken)
      : null;

    return {
      ...parsed,
      larkOpenId: userInfo.larkOpenId || parsed.larkOpenId,
      larkUserId: userInfo.larkUserId ?? parsed.larkUserId,
      larkName:   userInfo.larkName   ?? parsed.larkName,
      larkEmail:  userInfo.larkEmail  ?? contactEmail ?? parsed.larkEmail,
      larkEnName: userInfo.larkEnName ?? parsed.larkEnName,
      tenantKey:  userInfo.tenantKey  ?? parsed.tenantKey,
      scope:      parsed.scope,
      avatarUrl:  userInfo.avatarUrl  ?? parsed.avatarUrl,
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
      larkEmail:             firstNonBlankString(data['enterprise_email'], data['email']),
      larkEnName:            (data['en_name']   as string)       ?? null,
      tenantKey:             (data['tenant_key'] as string)      ?? null,
      scope:                 (data['scope'] as string)           ?? null,
      avatarUrl:             (data['avatar_url'] as string)      ?? null,
    };
  }
}
