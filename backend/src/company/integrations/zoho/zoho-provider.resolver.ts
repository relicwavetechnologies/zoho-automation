import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/prisma';
import type { ZohoProviderAdapter, ZohoProviderMode } from './zoho-provider.adapter';
import { ZohoIntegrationError } from './zoho.errors';
import { zohoRestAdapter } from './zoho-rest.adapter';

export type ResolvedZohoProvider = {
  connectionId: string;
  environment: string;
  providerMode: ZohoProviderMode;
  adapter: ZohoProviderAdapter;
};

export const resolveZohoProvider = async (input: {
  companyId: string;
  environment?: string;
}): Promise<ResolvedZohoProvider> => {
  const connection = await prisma.zohoConnection.findFirst({
    where: {
      companyId: input.companyId,
      status: 'CONNECTED',
      ...(input.environment ? { environment: input.environment } : {}),
    },
    orderBy: {
      connectedAt: 'desc',
    },
    select: {
      id: true,
      environment: true,
      providerMode: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
    },
  });

  if (!connection) {
    throw new ZohoIntegrationError({
      message: 'No active Zoho connection found',
      code: 'auth_failed',
      retriable: false,
    });
  }

  if (!connection.accessTokenEncrypted && !connection.refreshTokenEncrypted) {
    throw new ZohoIntegrationError({
      message: 'Zoho REST credentials are missing for this company. Reconnect the Zoho account through OAuth before using live CRM reads.',
      code: 'auth_failed',
      retriable: false,
    });
  }

  return {
    connectionId: connection.id,
    environment: connection.environment,
    providerMode: 'rest',
    adapter: zohoRestAdapter,
  };
};

export const resolveWithFallback = async (input: {
  companyId: string;
  environment?: string;
}): Promise<ResolvedZohoProvider & { fallbackUsed: boolean }> => {
  const resolved = await resolveZohoProvider(input);
  logger.debug('zoho.provider.resolved', {
    companyId: input.companyId,
    mode: 'rest',
    fallbackUsed: false,
  });
  return {
    ...resolved,
    fallbackUsed: false,
  };
};
