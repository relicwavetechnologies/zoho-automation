import config from '../../../config';
import { logger } from '../../../utils/logger';

export type LarkOAuthTokenResponse = {
  code?: number;
  msg?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  data?: {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_expires_in?: number;
  };
};

type LarkAppAccessTokenResponse = {
  code?: number;
  msg?: string;
  app_access_token?: string;
  expire?: number;
};

type LarkUserInfoResponse = {
  code?: number;
  msg?: string;
  data?: {
    name?: string;
    email?: string;
    open_id?: string;
    union_id?: string;
    user_id?: string;
    tenant_key?: string;
    avatar_url?: string;
  };
};

const readErrorMessage = (payload: { msg?: string; code?: number } | null | undefined, fallback: string): string => {
  const msg = typeof payload?.msg === 'string' && payload.msg.trim().length > 0 ? payload.msg.trim() : fallback;
  return typeof payload?.code === 'number' ? `${msg} (code=${payload.code})` : msg;
};

export class LarkOAuthService {
  private readonly apiBaseUrl = config.LARK_API_BASE_URL.replace(/\/$/, '');

  private readonly appId = config.LARK_APP_ID.trim();

  private readonly appSecret = config.LARK_APP_SECRET.trim();

  getRedirectUri(mode: 'admin' | 'desktop' = 'admin'): string {
    if (mode === 'desktop') {
      const backendBaseUrl = config.BACKEND_PUBLIC_URL.trim();
      return backendBaseUrl
        ? `${backendBaseUrl.replace(/\/$/, '')}/api/desktop/auth/lark/callback`
        : '';
    }
    const appBaseUrl = config.APP_BASE_URL.trim();
    return appBaseUrl ? `${appBaseUrl.replace(/\/$/, '')}/lark/callback` : '';
  }

  getAuthorizeUrl(input: { state: string; redirectUri?: string }): string {
    const redirectUri = input.redirectUri?.trim() || this.getRedirectUri('admin');
    if (!this.appId || !this.appSecret || !redirectUri) {
      throw new Error('Lark OAuth is not configured in server env');
    }

    const authorizeUrl = new URL('/open-apis/authen/v1/index', this.apiBaseUrl);
    authorizeUrl.searchParams.set('app_id', this.appId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', input.state);
    return authorizeUrl.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
    refreshExpiresIn?: number;
  }> {
    if (!this.appId || !this.appSecret) {
      throw new Error('Lark OAuth is not configured in server env');
    }

    const appAccessToken = await this.fetchAppAccessToken();
    const response = await fetch(`${this.apiBaseUrl}/open-apis/authen/v1/access_token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code.trim(),
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as LarkOAuthTokenResponse;
    const accessToken = payload.access_token?.trim() || payload.data?.access_token?.trim();
    const refreshToken = payload.refresh_token?.trim() || payload.data?.refresh_token?.trim() || undefined;
    const tokenType = payload.token_type?.trim() || payload.data?.token_type?.trim() || undefined;
    const expiresIn = typeof payload.expires_in === 'number'
      ? payload.expires_in
      : typeof payload.data?.expires_in === 'number'
        ? payload.data.expires_in
        : undefined;
    const refreshExpiresIn = typeof payload.refresh_expires_in === 'number'
      ? payload.refresh_expires_in
      : typeof payload.data?.refresh_expires_in === 'number'
        ? payload.data.refresh_expires_in
        : undefined;

    if (!response.ok || payload.code !== 0 || !accessToken) {
      logger.warn('lark.oauth.exchange.failed', {
        status: response.status,
        reason: readErrorMessage(payload, 'Lark authorization code exchange failed'),
      });
      throw new Error(readErrorMessage(payload, 'Lark authorization code exchange failed'));
    }

    return {
      accessToken,
      refreshToken,
      tokenType,
      expiresIn,
      refreshExpiresIn,
    };
  }

  private async fetchAppAccessToken(): Promise<string> {
    const response = await fetch(`${this.apiBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as LarkAppAccessTokenResponse;
    if (!response.ok || payload.code !== 0 || !payload.app_access_token) {
      logger.warn('lark.oauth.app_access_token.failed', {
        status: response.status,
        reason: readErrorMessage(payload, 'Lark app access token fetch failed'),
      });
      throw new Error(readErrorMessage(payload, 'Lark app access token fetch failed'));
    }

    return payload.app_access_token;
  }

  async fetchUserInfo(accessToken: string): Promise<{
    tenantKey: string;
    openId?: string;
    userId?: string;
    name?: string;
    email?: string;
  }> {
    const response = await fetch(`${this.apiBaseUrl}/open-apis/authen/v1/user_info`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const payload = (await response.json().catch(() => ({}))) as LarkUserInfoResponse;
    const tenantKey = payload.data?.tenant_key?.trim();
    if (!response.ok || payload.code !== 0 || !tenantKey) {
      logger.warn('lark.oauth.user_info.failed', {
        status: response.status,
        reason: readErrorMessage(payload, 'Unable to resolve Lark tenant information'),
      });
      throw new Error(readErrorMessage(payload, 'Unable to resolve Lark tenant information'));
    }

    return {
      tenantKey,
      openId: payload.data?.open_id,
      userId: payload.data?.user_id,
      name: payload.data?.name,
      email: payload.data?.email,
    };
  }

  isConfigured(mode: 'admin' | 'desktop' = 'admin'): boolean {
    return Boolean(this.appId && this.appSecret && this.getRedirectUri(mode).trim());
  }
}

export const larkOAuthService = new LarkOAuthService();
