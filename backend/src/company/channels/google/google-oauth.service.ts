import config from '../../../config';
import { logger } from '../../../utils/logger';
import { withProviderRetry } from '../../../utils/provider-retry';
import { redisTokenCache } from '../../../utils/redis-token-cache';

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfoResponse = {
  sub?: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
};

const GOOGLE_AUTH_BASE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const buildGoogleTokenCacheKey = (companyId: string, userId: string) => `google:token:${companyId}:${userId}`;

const DEFAULT_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

const readErrorMessage = (payload: GoogleTokenResponse | null | undefined, fallback: string): string => {
  const msg = payload?.error_description || payload?.error || fallback;
  return msg.trim().length > 0 ? msg.trim() : fallback;
};

const fetchGoogleWithRetry = async (
  url: string,
  init: RequestInit,
  fallbackMessage: string,
): Promise<Response> =>
  withProviderRetry('google', async () => {
    const response = await fetch(url, init);
    if (!response.ok) {
      const payload = (await response.clone().json().catch(() => ({}))) as GoogleTokenResponse;
      const error: Error & {
        status?: number;
        headers?: Record<string, string>;
        payload?: GoogleTokenResponse;
      } = new Error(readErrorMessage(payload, fallbackMessage));
      error.status = response.status;
      error.headers = Object.fromEntries(response.headers.entries());
      error.payload = payload;
      throw error;
    }
    return response;
  });

export class GoogleOAuthService {
  private readonly clientId = config.GOOGLE_OAUTH_CLIENT_ID.trim();
  private readonly clientSecret = config.GOOGLE_OAUTH_CLIENT_SECRET.trim();

  getRedirectUri(): string {
    if (config.GOOGLE_OAUTH_REDIRECT_URI.trim().length > 0) {
      return config.GOOGLE_OAUTH_REDIRECT_URI.trim();
    }
    const backendBaseUrl = config.BACKEND_PUBLIC_URL.trim();
    return backendBaseUrl ? `${backendBaseUrl.replace(/\/$/, '')}/api/desktop/auth/google/callback` : '';
  }

  getAuthorizeUrl(input: { state: string; redirectUri?: string; scopes?: string[] }): string {
    const redirectUri = input.redirectUri?.trim() || this.getRedirectUri();
    if (!this.clientId || !this.clientSecret || !redirectUri) {
      throw new Error('Google OAuth is not configured in server env');
    }

    const url = new URL(GOOGLE_AUTH_BASE_URL);
    const scopes = (input.scopes && input.scopes.length > 0 ? input.scopes : DEFAULT_SCOPES).join(' ');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  getScopes(): string[] {
    return [...DEFAULT_SCOPES];
  }

  async exchangeAuthorizationCode(code: string, redirectUri?: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
    scope?: string;
  }> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Google OAuth is not configured in server env');
    }

    try {
      const response = await fetchGoogleWithRetry(
        GOOGLE_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code: code.trim(),
            grant_type: 'authorization_code',
            redirect_uri: redirectUri?.trim() || this.getRedirectUri(),
          }),
        },
        'Google authorization code exchange failed',
      );

      const payload = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
      const accessToken = payload.access_token?.trim();
      if (!accessToken) {
        throw new Error(readErrorMessage(payload, 'Google authorization code exchange failed'));
      }

      return {
        accessToken,
        refreshToken: payload.refresh_token?.trim() || undefined,
        tokenType: payload.token_type?.trim() || undefined,
        expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
        scope: payload.scope?.trim() || undefined,
      };
    } catch (error) {
      const payload = ((error as any)?.payload ?? {}) as GoogleTokenResponse;
      const status = (error as any)?.status;
      logger.warn('google.oauth.exchange.failed', {
        status,
        reason: readErrorMessage(payload, error instanceof Error ? error.message : 'Google authorization code exchange failed'),
      });
      throw new Error(readErrorMessage(payload, 'Google authorization code exchange failed'));
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    tokenType?: string;
    expiresIn?: number;
    scope?: string;
  }> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('Google OAuth is not configured in server env');
    }

    try {
      const response = await fetchGoogleWithRetry(
        GOOGLE_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: refreshToken.trim(),
            grant_type: 'refresh_token',
          }),
        },
        'Google access token refresh failed',
      );

      const payload = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
      const accessToken = payload.access_token?.trim();
      if (!accessToken) {
        throw new Error(readErrorMessage(payload, 'Google access token refresh failed'));
      }

      return {
        accessToken,
        tokenType: payload.token_type?.trim() || undefined,
        expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
        scope: payload.scope?.trim() || undefined,
      };
    } catch (error) {
      const payload = ((error as any)?.payload ?? {}) as GoogleTokenResponse;
      const status = (error as any)?.status;
      logger.warn('google.oauth.refresh.failed', {
        status,
        reason: readErrorMessage(payload, error instanceof Error ? error.message : 'Google access token refresh failed'),
      });
      throw new Error(readErrorMessage(payload, 'Google access token refresh failed'));
    }
  }

  async getValidAccessToken(
    companyId: string,
    userId: string,
    storedRefreshToken: string,
  ): Promise<string> {
    const cached = await redisTokenCache.get(buildGoogleTokenCacheKey(companyId, userId));
    if (cached) {
      return cached.token;
    }

    const refreshed = await this.refreshAccessToken(storedRefreshToken);
    const expiresAtMs = Date.now() + (refreshed.expiresIn ?? 3600) * 1000;
    await redisTokenCache.set(
      buildGoogleTokenCacheKey(companyId, userId),
      refreshed.accessToken,
      expiresAtMs,
    );
    return refreshed.accessToken;
  }

  async fetchUserInfo(accessToken: string): Promise<{
    sub: string;
    email?: string;
    name?: string;
  }> {
    try {
      const response = await fetchGoogleWithRetry(
        GOOGLE_USERINFO_URL,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        'Unable to resolve Google user info',
      );
      const payload = (await response.json().catch(() => ({}))) as GoogleUserInfoResponse;
      const sub = payload.sub?.trim();
      if (!sub) {
        throw new Error('Unable to resolve Google user info');
      }

      return {
        sub,
        email: payload.email,
        name: payload.name,
      };
    } catch (error) {
      const status = (error as any)?.status;
      logger.warn('google.oauth.user_info.failed', {
        status,
        reason: readErrorMessage(undefined, 'Unable to resolve Google user info'),
      });
      throw new Error('Unable to resolve Google user info');
    }
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.getRedirectUri().trim());
  }
}

export const googleOAuthService = new GoogleOAuthService();
