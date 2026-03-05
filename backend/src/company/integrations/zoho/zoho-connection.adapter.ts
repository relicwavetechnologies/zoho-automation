import type { ZohoConnectionDTO } from '../../contracts';
import { logger } from '../../../utils/logger';
import { ZohoIntegrationError } from './zoho.errors';
import { zohoTokenService } from './zoho-token.service';

export type ZohoConnectInput = {
  authorizationCode: string;
  scopes: string[];
  environment: string;
};

export type ZohoConnectResult = ZohoConnectionDTO & {
  provider: 'zoho';
  tokenState: {
    accessTokenEncrypted: string;
    refreshTokenEncrypted?: string;
    tokenCipherVersion: number;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt?: string;
    tokenMetadata?: Record<string, unknown>;
  };
};

export class ZohoConnectionAdapter {
  async connect(input: ZohoConnectInput, companyId: string): Promise<ZohoConnectResult> {
    try {
      const exchanged = await zohoTokenService.exchangeAuthorizationCode({
        authorizationCode: input.authorizationCode,
        scopes: input.scopes,
        environment: input.environment,
      });

      return {
        provider: 'zoho',
        companyId,
        status: 'CONNECTED',
        connectedAt: new Date().toISOString(),
        scopes: exchanged.scopes,
        tokenState: {
          accessTokenEncrypted: exchanged.accessTokenEncrypted,
          refreshTokenEncrypted: exchanged.refreshTokenEncrypted,
          tokenCipherVersion: exchanged.tokenCipherVersion,
          accessTokenExpiresAt: exchanged.accessTokenExpiresAt.toISOString(),
          refreshTokenExpiresAt: exchanged.refreshTokenExpiresAt?.toISOString(),
          tokenMetadata: exchanged.tokenMetadata,
        },
      };
    } catch (error) {
      logger.error('zoho.oauth.exchange.failed', {
        companyId,
        environment: input.environment,
        failureCode: error instanceof ZohoIntegrationError ? error.code : 'unknown',
        error,
      });

      if (error instanceof ZohoIntegrationError) {
        throw error;
      }

      throw new ZohoIntegrationError({
        message: error instanceof Error ? error.message : 'Zoho connection failed',
        code: 'auth_failed',
        retriable: false,
      });
    }
  }
}

export const zohoConnectionAdapter = new ZohoConnectionAdapter();
