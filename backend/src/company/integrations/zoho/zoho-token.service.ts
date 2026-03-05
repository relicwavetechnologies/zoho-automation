import type { ZohoConnection } from '../../../generated/prisma';
import config from '../../../config';
import { prisma } from '../../../utils/prisma';
import { logger } from '../../../utils/logger';
import { decryptZohoSecret, encryptZohoSecret } from './zoho-token.crypto';
import { zohoHttpClient, ZohoHttpClient } from './zoho-http.client';
import { ZohoIntegrationError } from './zoho.errors';

type ZohoTokenServiceOptions = {
  httpClient?: ZohoHttpClient;
  now?: () => number;
};

type ZohoTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  refresh_token_expires_in?: number | string;
  api_domain?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export type ZohoTokenExchangeResult = {
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  tokenCipherVersion: number;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt?: Date;
  scopes: string[];
  tokenMetadata?: Record<string, unknown>;
};

type CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const REFRESH_BUFFER_MS = 120 * 1000;

const toNumber = (value: number | string | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const parseScopes = (input: string | undefined, fallback: string[]): string[] => {
  if (!input || input.trim().length === 0) {
    return fallback;
  }

  return input
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
};

const ensureConnected = (connection: ZohoConnection | null): ZohoConnection => {
  if (!connection || connection.status !== 'CONNECTED') {
    throw new ZohoIntegrationError({
      message: 'No active Zoho connection found',
      code: 'auth_failed',
      retriable: false,
    });
  }

  return connection;
};

const connectionKey = (companyId: string, environment: string) => `${companyId}:${environment}`;

export class ZohoTokenService {
  private readonly httpClient: ZohoHttpClient;

  private readonly now: () => number;

  private readonly cache = new Map<string, CachedToken>();

  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: ZohoTokenServiceOptions = {}) {
    this.httpClient = options.httpClient ?? zohoHttpClient;
    this.now = options.now ?? (() => Date.now());
  }

  async exchangeAuthorizationCode(input: {
    authorizationCode: string;
    scopes: string[];
    environment: string;
  }): Promise<ZohoTokenExchangeResult> {
    if (!config.ZOHO_CLIENT_ID || !config.ZOHO_CLIENT_SECRET || !config.ZOHO_REDIRECT_URI) {
      throw new ZohoIntegrationError({
        message: 'Zoho OAuth credentials are not configured',
        code: 'auth_failed',
        retriable: false,
      });
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.ZOHO_CLIENT_ID,
      client_secret: config.ZOHO_CLIENT_SECRET,
      redirect_uri: config.ZOHO_REDIRECT_URI,
      code: input.authorizationCode,
    });

    const payload = await this.httpClient.requestJson<ZohoTokenResponse>({
      base: 'accounts',
      path: '/oauth/v2/token',
      method: 'POST',
      body,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 250,
      },
    });

    if (!payload.access_token) {
      throw new ZohoIntegrationError({
        message: payload.error_description || payload.error || 'Zoho authorization_code exchange failed',
        code: 'auth_failed',
        retriable: false,
      });
    }

    const expiresInSeconds = toNumber(payload.expires_in) ?? 3600;
    const refreshExpiresInSeconds = toNumber(payload.refresh_token_expires_in);
    const nowMs = this.now();
    const encryptedAccess = encryptZohoSecret(payload.access_token);
    const encryptedRefresh = payload.refresh_token ? encryptZohoSecret(payload.refresh_token) : undefined;

    logger.info('zoho.oauth.exchange.success', {
      environment: input.environment,
      expiresInSeconds,
      hasRefreshToken: Boolean(payload.refresh_token),
    });

    return {
      accessTokenEncrypted: encryptedAccess.cipherText,
      refreshTokenEncrypted: encryptedRefresh?.cipherText,
      tokenCipherVersion: encryptedAccess.version,
      accessTokenExpiresAt: new Date(nowMs + expiresInSeconds * 1000),
      refreshTokenExpiresAt:
        refreshExpiresInSeconds !== null ? new Date(nowMs + refreshExpiresInSeconds * 1000) : undefined,
      scopes: parseScopes(payload.scope, input.scopes),
      tokenMetadata: {
        apiDomain: payload.api_domain,
        tokenType: payload.token_type,
      },
    };
  }

  async getValidAccessToken(companyId: string, environment = 'prod'): Promise<string> {
    const key = connectionKey(companyId, environment);
    const cached = this.cache.get(key);

    if (cached && this.now() + REFRESH_BUFFER_MS < cached.expiresAtMs) {
      return cached.accessToken;
    }

    const connection = ensureConnected(
      await prisma.zohoConnection.findUnique({
        where: {
          companyId_environment: {
            companyId,
            environment,
          },
        },
      }),
    );

    if (
      connection.accessTokenEncrypted &&
      connection.accessTokenExpiresAt &&
      this.now() + REFRESH_BUFFER_MS < connection.accessTokenExpiresAt.getTime()
    ) {
      const token = decryptZohoSecret(connection.accessTokenEncrypted);
      this.cache.set(key, {
        accessToken: token,
        expiresAtMs: connection.accessTokenExpiresAt.getTime(),
      });
      return token;
    }

    return this.forceRefresh(companyId, environment);
  }

  async forceRefresh(companyId: string, environment = 'prod'): Promise<string> {
    const key = connectionKey(companyId, environment);
    if (!this.inFlight.has(key)) {
      this.inFlight.set(
        key,
        this.refreshWithStoredToken(companyId, environment).finally(() => {
          this.inFlight.delete(key);
        }),
      );
    }

    return this.inFlight.get(key)!;
  }

  private async refreshWithStoredToken(companyId: string, environment: string): Promise<string> {
    const connection = ensureConnected(
      await prisma.zohoConnection.findUnique({
        where: {
          companyId_environment: {
            companyId,
            environment,
          },
        },
      }),
    );

    if (!connection.refreshTokenEncrypted) {
      throw new ZohoIntegrationError({
        message: 'Missing Zoho refresh token for connected company',
        code: 'token_refresh_failed',
        retriable: false,
      });
    }

    const refreshToken = decryptZohoSecret(connection.refreshTokenEncrypted);

    try {
      const payload = await this.httpClient.requestJson<ZohoTokenResponse>({
        base: 'accounts',
        path: '/oauth/v2/token',
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.ZOHO_CLIENT_ID,
          client_secret: config.ZOHO_CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
        retry: {
          maxAttempts: 3,
          baseDelayMs: 250,
        },
      });

      if (!payload.access_token) {
        throw new ZohoIntegrationError({
          message: payload.error_description || payload.error || 'Zoho refresh token exchange failed',
          code: 'token_refresh_failed',
          retriable: false,
        });
      }

      const expiresInSeconds = toNumber(payload.expires_in) ?? 3600;
      const nowMs = this.now();
      const accessTokenExpiresAt = new Date(nowMs + expiresInSeconds * 1000);
      const encryptedAccess = encryptZohoSecret(payload.access_token);
      const encryptedRefresh = payload.refresh_token ? encryptZohoSecret(payload.refresh_token) : undefined;

      await prisma.zohoConnection.update({
        where: {
          companyId_environment: {
            companyId,
            environment,
          },
        },
        data: {
          accessTokenEncrypted: encryptedAccess.cipherText,
          refreshTokenEncrypted: encryptedRefresh?.cipherText ?? connection.refreshTokenEncrypted,
          accessTokenExpiresAt,
          tokenFailureCode: null,
          lastTokenRefreshAt: new Date(nowMs),
          tokenMetadata: {
            ...(connection.tokenMetadata as Record<string, unknown> | null),
            apiDomain: payload.api_domain,
            tokenType: payload.token_type,
          },
        },
      });

      this.cache.set(connectionKey(companyId, environment), {
        accessToken: payload.access_token,
        expiresAtMs: accessTokenExpiresAt.getTime(),
      });

      logger.info('zoho.oauth.refresh.success', {
        companyId,
        environment,
        expiresInSeconds,
      });

      return payload.access_token;
    } catch (error) {
      const reason = error instanceof ZohoIntegrationError ? error.code : 'token_refresh_failed';
      await prisma.zohoConnection.update({
        where: {
          companyId_environment: {
            companyId,
            environment,
          },
        },
        data: {
          tokenFailureCode: reason,
        },
      });

      logger.error('zoho.oauth.refresh.failed', {
        companyId,
        environment,
        failureCode: reason,
        error,
      });

      if (error instanceof ZohoIntegrationError) {
        throw error;
      }

      throw new ZohoIntegrationError({
        message: error instanceof Error ? error.message : 'Zoho token refresh failed',
        code: 'token_refresh_failed',
        retriable: false,
      });
    }
  }
}

export const zohoTokenService = new ZohoTokenService();
