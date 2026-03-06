import { decryptZohoSecret } from './zoho-token.crypto';
import { mcpHttpClient, McpHttpClient } from './mcp-http.client';
import { ZohoFailureCode, ZohoIntegrationError } from './zoho.errors';
import type {
  ZohoProviderActionInput,
  ZohoProviderAdapter,
  ZohoProviderContext,
  ZohoProviderHealth,
  ZohoProviderHistoricalPageInput,
  ZohoProviderHistoricalPageResult,
  ZohoSourceType,
} from './zoho-provider.adapter';
import { prisma } from '../../../utils/prisma';

const MODULE_MAP: Record<ZohoSourceType, string> = {
  zoho_contact: 'contacts',
  zoho_deal: 'deals',
  zoho_ticket: 'tickets',
};

type McpConnection = {
  id: string;
  companyId: string;
  mcpBaseUrl: string;
  mcpApiKeyEncrypted: string;
  mcpWorkspaceKey: string | null;
  mcpAllowedTools: string[];
  mcpCapabilities: unknown;
};

type ParsedHistoricalPage = {
  records: Array<{ sourceType: ZohoSourceType; sourceId: string; payload: Record<string, unknown> }>;
  nextCursor?: string;
  total?: number;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
};

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readCapabilities = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }
  return [];
};

const parseHistoricalRecords = (payload: Record<string, unknown>): ParsedHistoricalPage => {
  const recordsRaw = Array.isArray(payload.records)
    ? payload.records
    : Array.isArray(payload.data)
      ? payload.data
      : [];

  const records = recordsRaw
    .map((candidate) => {
      const item = asRecord(candidate);
      if (!item) {
        return null;
      }
      const sourceType = readString(item.sourceType) as ZohoSourceType | undefined;
      const sourceId = readString(item.sourceId ?? item.id);
      const payloadValue = asRecord(item.payload) ?? item;
      if (!sourceType || !sourceId || !payloadValue) {
        return null;
      }
      return {
        sourceType,
        sourceId,
        payload: payloadValue,
      };
    })
    .filter((item): item is { sourceType: ZohoSourceType; sourceId: string; payload: Record<string, unknown> } => Boolean(item));

  return {
    records,
    nextCursor: readString(payload.nextCursor ?? payload.next_cursor ?? payload.cursor),
    total:
      typeof payload.total === 'number'
        ? payload.total
        : typeof payload.count === 'number'
          ? payload.count
          : undefined,
  };
};

const ensureAllowedTool = (input: { toolName: string; allowedTools: string[] }): void => {
  if (input.allowedTools.length === 0) {
    return;
  }

  if (!input.allowedTools.includes(input.toolName)) {
    throw new ZohoIntegrationError({
      message: `MCP tool is not allowlisted: ${input.toolName}`,
      code: 'mcp_tool_not_allowed',
      retriable: false,
    });
  }
};

const readToolFromCapabilities = (
  capabilities: string[],
  candidates: string[],
  fallback: string,
): string => {
  for (const candidate of candidates) {
    if (capabilities.includes(candidate)) {
      return candidate;
    }
  }
  return fallback;
};

const inferSourceTypeFromModule = (moduleName: string): ZohoSourceType => {
  if (moduleName === 'deals') {
    return 'zoho_deal';
  }
  if (moduleName === 'tickets') {
    return 'zoho_ticket';
  }
  return 'zoho_contact';
};

export class ZohoMcpAdapter implements ZohoProviderAdapter {
  readonly mode = 'mcp' as const;

  constructor(private readonly client: McpHttpClient = mcpHttpClient) {}

  private async loadConnection(context: ZohoProviderContext): Promise<McpConnection> {
    const connection = await prisma.zohoConnection.findUnique({
      where: { id: context.connectionId },
      select: {
        id: true,
        companyId: true,
        mcpBaseUrl: true,
        mcpApiKeyEncrypted: true,
        mcpWorkspaceKey: true,
        mcpAllowedTools: true,
        mcpCapabilities: true,
      },
    });

    if (!connection || connection.companyId !== context.companyId) {
      throw new ZohoIntegrationError({
        message: 'MCP connection not found for company context',
        code: 'auth_failed',
        retriable: false,
      });
    }

    if (!connection.mcpBaseUrl || !connection.mcpApiKeyEncrypted) {
      throw new ZohoIntegrationError({
        message: 'MCP connection missing base URL or encrypted API key',
        code: 'auth_failed',
        retriable: false,
      });
    }

    return {
      ...connection,
      mcpBaseUrl: connection.mcpBaseUrl,
      mcpApiKeyEncrypted: connection.mcpApiKeyEncrypted,
    };
  }

  private async callTool(input: {
    context: ZohoProviderContext;
    toolName: string;
    argumentsPayload: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const connection = await this.loadConnection(input.context);
    ensureAllowedTool({
      toolName: input.toolName,
      allowedTools: connection.mcpAllowedTools,
    });

    const apiKey = decryptZohoSecret(connection.mcpApiKeyEncrypted);
    return this.client.callTool({
      baseUrl: connection.mcpBaseUrl,
      apiKey,
      workspaceKey: connection.mcpWorkspaceKey ?? undefined,
      toolName: input.toolName,
      argumentsPayload: input.argumentsPayload,
    });
  }

  async discoverCapabilities(context: ZohoProviderContext): Promise<string[]> {
    const connection = await this.loadConnection(context);
    const apiKey = decryptZohoSecret(connection.mcpApiKeyEncrypted);
    const discovered = await this.client.listTools({
      baseUrl: connection.mcpBaseUrl,
      apiKey,
      workspaceKey: connection.mcpWorkspaceKey ?? undefined,
    });
    const persisted = readCapabilities(connection.mcpCapabilities);
    return [...new Set([...persisted, ...discovered])];
  }

  async health(context: ZohoProviderContext): Promise<ZohoProviderHealth> {
    const startedAt = Date.now();
    try {
      const capabilities = await this.discoverCapabilities(context);
      return {
        ok: true,
        status: 'healthy',
        providerMode: this.mode,
        latencyMs: Date.now() - startedAt,
        details: {
          capabilityCount: capabilities.length,
        },
      };
    } catch (error) {
      const failureCode = error instanceof ZohoIntegrationError ? error.code : 'mcp_unavailable';
      return {
        ok: false,
        status: failureCode === 'rate_limited' ? 'degraded' : 'failed',
        providerMode: this.mode,
        latencyMs: Date.now() - startedAt,
        reasonCode: failureCode,
      };
    }
  }

  async fetchHistoricalPage(input: ZohoProviderHistoricalPageInput): Promise<ZohoProviderHistoricalPageResult> {
    const cursorState = input.cursor
      ? (JSON.parse(input.cursor) as { module?: string; cursor?: string } | null)
      : null;
    const moduleName = cursorState?.module ?? 'contacts';
    const pageCursor = cursorState?.cursor;
    const capabilities = await this.discoverCapabilities(input.context);
    const toolName = readToolFromCapabilities(
      capabilities,
      [`zoho.${moduleName}.list`, `${moduleName}.list`, `list_${moduleName}`],
      `zoho.${moduleName}.list`,
    );
    const payload = await this.callTool({
      context: input.context,
      toolName,
      argumentsPayload: {
        cursor: pageCursor,
        pageSize: input.pageSize,
      },
    });

    const parsed = parseHistoricalRecords(payload);
    const nextModule = moduleName === 'contacts' ? 'deals' : moduleName === 'deals' ? 'tickets' : undefined;
    const nextCursor = parsed.nextCursor
      ? JSON.stringify({ module: moduleName, cursor: parsed.nextCursor })
      : nextModule
        ? JSON.stringify({ module: nextModule, cursor: null })
        : undefined;

    const normalizedRecords = parsed.records.map((record) => ({
      sourceType: record.sourceType ?? inferSourceTypeFromModule(moduleName),
      sourceId: record.sourceId,
      payload: record.payload,
    }));

    return {
      records: normalizedRecords,
      nextCursor,
      total: parsed.total,
    };
  }

  async fetchRecordBySource(input: {
    context: ZohoProviderContext;
    sourceType: ZohoSourceType;
    sourceId: string;
  }): Promise<Record<string, unknown> | null> {
    const moduleName = MODULE_MAP[input.sourceType] ?? 'contacts';
    const capabilities = await this.discoverCapabilities(input.context);
    const toolName = readToolFromCapabilities(
      capabilities,
      [`zoho.${moduleName}.get`, `${moduleName}.get`, `get_${moduleName}`],
      `zoho.${moduleName}.get`,
    );
    const payload = await this.callTool({
      context: input.context,
      toolName,
      argumentsPayload: {
        id: input.sourceId,
      },
    });

    const record = asRecord(payload.record ?? payload.data ?? payload.result ?? payload);
    return record ?? null;
  }

  async executeAction(input: ZohoProviderActionInput): Promise<{
    actionName: string;
    status: 'success' | 'failed';
    receipt?: Record<string, unknown>;
    failureCode?: ZohoFailureCode;
    message?: string;
  }> {
    if (!input.hitlConfirmed) {
      return {
        actionName: input.actionName,
        status: 'failed',
        failureCode: 'mcp_action_requires_hitl',
        message: 'HITL confirmation is required for MCP action execution',
      };
    }

    try {
      const receipt = await this.callTool({
        context: input.context,
        toolName: input.actionName,
        argumentsPayload: input.payload,
      });
      return {
        actionName: input.actionName,
        status: 'success',
        receipt,
      };
    } catch (error) {
      if (error instanceof ZohoIntegrationError) {
        return {
          actionName: input.actionName,
          status: 'failed',
          failureCode: error.code,
          message: error.message,
        };
      }
      return {
        actionName: input.actionName,
        status: 'failed',
        failureCode: 'mcp_unavailable',
        message: error instanceof Error ? error.message : 'Unknown MCP action failure',
      };
    }
  }
}

export const zohoMcpAdapter = new ZohoMcpAdapter();
