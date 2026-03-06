import config from '../../../config';
import { logger } from '../../../utils/logger';
import { prisma } from '../../../utils/prisma';
import type { ZohoProviderAdapter, ZohoProviderMode } from './zoho-provider.adapter';
import { ZohoIntegrationError } from './zoho.errors';
import { zohoMcpAdapter } from './zoho-mcp.adapter';
import { zohoRestAdapter } from './zoho-rest.adapter';

export type ResolvedZohoProvider = {
  connectionId: string;
  environment: string;
  providerMode: ZohoProviderMode;
  adapter: ZohoProviderAdapter;
};

const pickProviderMode = (input: {
  connectionMode: string;
  hasMcpCreds: boolean;
}): ZohoProviderMode => {
  if (input.connectionMode === 'mcp' && config.ZOHO_MCP_ENABLED && input.hasMcpCreds) {
    return 'mcp';
  }
  if (config.ZOHO_PROVIDER_DEFAULT === 'mcp' && config.ZOHO_MCP_ENABLED && input.hasMcpCreds) {
    return 'mcp';
  }
  return 'rest';
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
      mcpBaseUrl: true,
      mcpApiKeyEncrypted: true,
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

  const hasMcpCreds = Boolean(connection.mcpBaseUrl && connection.mcpApiKeyEncrypted);
  const mode = pickProviderMode({
    connectionMode: connection.providerMode,
    hasMcpCreds,
  });

  if (mode === 'rest' && !connection.accessTokenEncrypted && !connection.refreshTokenEncrypted) {
    if (hasMcpCreds && config.ZOHO_MCP_ENABLED) {
      logger.warn('zoho.provider.fallback_mcp_due_missing_rest_credentials', {
        companyId: input.companyId,
        connectionId: connection.id,
      });
      return {
        connectionId: connection.id,
        environment: connection.environment,
        providerMode: 'mcp',
        adapter: zohoMcpAdapter,
      };
    }

    throw new ZohoIntegrationError({
      message: 'REST provider selected but OAuth credentials are missing',
      code: 'auth_failed',
      retriable: false,
    });
  }

  return {
    connectionId: connection.id,
    environment: connection.environment,
    providerMode: mode,
    adapter: mode === 'mcp' ? zohoMcpAdapter : zohoRestAdapter,
  };
};

/**
 * Resolve the best available Zoho provider, trying MCP first and gracefully
 * falling back to REST if MCP credentials are absent or the MCP health-check
 * fails at the connection level.  The caller never needs to know which adapter
 * was ultimately chosen.
 */
export const resolveWithFallback = async (input: {
  companyId: string;
  environment?: string;
}): Promise<ResolvedZohoProvider & { fallbackUsed: boolean }> => {
  // ── Pass 1: attempt MCP ──────────────────────────────────────────────────
  const mcpEnabled = config.ZOHO_MCP_ENABLED || config.ZOHO_PROVIDER_DEFAULT === 'mcp';
  if (mcpEnabled) {
    try {
      // Force the resolver to prefer MCP by checking via the standard resolver;
      // if it picks MCP, great. If credentials are missing it will throw.
      const resolved = await resolveZohoProvider(input);
      if (resolved.providerMode === 'mcp') {
        logger.debug('zoho.provider.resolved', {
          companyId: input.companyId,
          mode: 'mcp',
          fallbackUsed: false,
        });
        return { ...resolved, fallbackUsed: false };
      }
    } catch (mcpError) {
      logger.warn('zoho.provider.mcp_resolve_failed', {
        companyId: input.companyId,
        reason: mcpError instanceof Error ? mcpError.message : 'unknown',
      });
    }
  }

  // ── Pass 2: fall back to REST ────────────────────────────────────────────
  const connection = await prisma.zohoConnection.findFirst({
    where: {
      companyId: input.companyId,
      status: 'CONNECTED',
      ...(input.environment ? { environment: input.environment } : {}),
    },
    orderBy: { connectedAt: 'desc' },
    select: {
      id: true,
      environment: true,
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
    },
  });

  if (!connection || (!connection.accessTokenEncrypted && !connection.refreshTokenEncrypted)) {
    throw new ZohoIntegrationError({
      message: 'No active Zoho connection with valid credentials found (MCP and REST both unavailable)',
      code: 'auth_failed',
      retriable: false,
    });
  }

  logger.warn('zoho.provider.fallback_to_rest', {
    companyId: input.companyId,
    connectionId: connection.id,
  });

  return {
    connectionId: connection.id,
    environment: connection.environment,
    providerMode: 'rest',
    adapter: zohoRestAdapter,
    fallbackUsed: true,
  };
};
