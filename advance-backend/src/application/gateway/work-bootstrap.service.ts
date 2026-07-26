import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolRegistry } from '../orchestration/tools/tool-registry';
import type { PermissionResult } from '../permissions/permission.types';
import { asToolId } from '../../shared/ids';
import type {
  AccessibleConnection,
  ConnectionProvider,
  ConnectionRegistryPort,
} from '../connections/connection-registry.port';
import { GOOGLE_WORKSPACE_TOOL_IDS } from '../google/google-workspace-mcp-manifest';
import { AIRTABLE_TOOL_IDS } from '../airtable/airtable-mcp-manifest';
import { withWorkDiscoveryPermissions } from './work-resolution.service';
import type { WorkContractBootstrapPort } from './work-contract-bootstrap.port';

// zod-to-json-schema's recursive generic overflows when the registry erases a
// concrete tool to Tool<unknown, unknown>. Keep that type mismatch at this
// serialization boundary; the original Zod schema remains the validator.
export const serializeToolArgsSchema = zodToJsonSchema as unknown as (
  schema: unknown,
  options: { $refStrategy: 'none' },
) => unknown;

export const LARK_CONNECTION_TOOL_IDS = new Set([
  'larkTask',
  'larkMessaging',
  'larkContacts',
  'larkCalendar',
  'larkMeeting',
  'larkDoc',
  'larkBase',
  'larkApproval',
]);

export type WorkBootstrapAdvisory = {
  readonly code:
    | 'contracts_loaded'
    | 'native_contracts_loaded'
    | 'native_contracts_unavailable'
    | 'connections_loaded'
    | 'connection_required'
    | 'connection_registry_unavailable';
  readonly level: 'required' | 'info';
  readonly instruction: string;
  readonly provider?: ConnectionProvider;
};

export interface WorkBootstrap {
  readonly version: 1;
  readonly scope: 'run';
  readonly registryRevision: number;
  readonly tools: Array<Record<string, unknown>>;
  readonly nativeContracts: Array<Record<string, unknown>>;
  readonly connections: Array<Record<string, unknown>>;
  readonly advisories: WorkBootstrapAdvisory[];
}

export interface WorkBootstrapDeps {
  readonly toolRegistry: ToolRegistry;
  readonly connectionRegistry?: ConnectionRegistryPort;
  readonly workContractBootstrap?: WorkContractBootstrapPort;
}

/**
 * Builds the discovery context a resolved workflow needs before it runs: the
 * exact tool contracts, the accounts the member may actually use, and the
 * native operation schemas those tools expect.
 *
 * This is discovery context, not execution authority: each later invocation
 * still resolves RBAC, connection policy, approval, and rate limits through
 * ToolExecutor.
 *
 * Shared by the desktop gateway and the backend-hosted channels on purpose.
 * When only the gateway built it, a Lark run reached Google Workspace with no
 * accessible account in hand — and the tool schema requires an exact
 * connectionId — so the model could only guess, and guessing always failed.
 */
export class WorkBootstrapService {
  constructor(private readonly deps: WorkBootstrapDeps) {}

  async build(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly permission: PermissionResult;
    readonly registryRevision: number;
    readonly query?: string;
    readonly toolIds: readonly string[];
  }): Promise<WorkBootstrap> {
    const discoveryPerm = withWorkDiscoveryPermissions(input.permission);
    const requestedToolIds = new Set(input.toolIds);
    const tools = this.deps.toolRegistry
      .forRuntime(discoveryPerm)
      .filter(tool => tool.id !== 'runCommand' && requestedToolIds.has(tool.id))
      .map(tool => ({
        id: tool.id,
        family: tool.family,
        description: tool.description,
        allowedActions: [...(discoveryPerm.allowedActionsByTool.get(asToolId(tool.id)) ?? [])],
        parameterDocs: tool.parameterDocs,
        argsSchema: serializeToolArgsSchema(tool.argsSchema, { $refStrategy: 'none' }),
      }));

    const providers = connectionProvidersForToolIds(tools.map(tool => String(tool.id)));
    const advisories: WorkBootstrapAdvisory[] = [];
    if (tools.length > 0) {
      advisories.push({
        code: 'contracts_loaded',
        level: 'required',
        instruction: 'Exact tool contracts for this work are already loaded below. Do not call tools.list again for these tools during this run.',
      });
    }

    const connections: AccessibleConnection[] = [];
    if (providers.length > 0 && !this.deps.connectionRegistry) {
      advisories.push({
        code: 'connection_registry_unavailable',
        level: 'required',
        instruction: 'Connected-account discovery is unavailable. Do not guess a connection ID.',
      });
    } else if (this.deps.connectionRegistry) {
      const results = await Promise.all(providers.map(async provider => ({
        provider,
        result: await this.listAccessibleConnections(input, provider),
      })));
      for (const { provider, result } of results) {
        if (!result.ok) {
          advisories.push({
            code: 'connection_registry_unavailable',
            level: 'required',
            provider,
            instruction: `${provider} account discovery failed. Do not guess a connection ID; report the connection problem if this provider is required.`,
          });
          continue;
        }
        connections.push(...result.value);
        if (result.value.length === 0) {
          advisories.push({
            code: 'connection_required',
            level: 'required',
            provider,
            instruction: `No accessible ${provider} account is available for the selected workflow. Ask the user to connect or share one instead of guessing credentials.`,
          });
        }
      }
      if (connections.length > 0) {
        advisories.push({
          code: 'connections_loaded',
          level: 'required',
          instruction: 'Accessible accounts required by this work are already loaded below. Reuse the selected exact connectionId and do not call connections.list again during this run.',
        });
      }
    }

    let nativeContracts: Array<Record<string, unknown>> = [];
    if (input.query && this.deps.workContractBootstrap && tools.length > 0) {
      let loaded;
      try {
        loaded = await this.deps.workContractBootstrap.load({
          member: { companyId: input.companyId, userId: input.userId },
          query: input.query,
          toolIds: tools.map(tool => String(tool.id)),
          connections,
        });
      } catch {
        loaded = {
          contracts: [],
          unavailableNativeTools: [],
        };
        advisories.push({
          code: 'native_contracts_unavailable',
          level: 'required',
          instruction: 'Native contract preload is temporarily unavailable. Describe only the exact operations the workflow actually requires.',
        });
      }
      nativeContracts = loaded.contracts.map(contract => ({
        toolId: contract.toolId,
        nativeTool: contract.nativeTool,
        ...(contract.description ? { description: contract.description } : {}),
        inputSchema: contract.inputSchema,
      }));
      if (nativeContracts.length > 0) {
        advisories.push({
          code: 'native_contracts_loaded',
          level: 'required',
          instruction: 'Likely native operation contracts for this workflow are already loaded below. Use their exact field names and do not call describe again for these operations during this run.',
        });
      }
      if (loaded.unavailableNativeTools.length > 0) {
        advisories.push({
          code: 'native_contracts_unavailable',
          level: 'required',
          instruction: `Native contracts could not be preloaded for: ${loaded.unavailableNativeTools.join(', ')}. Describe only those operations if the workflow actually requires them.`,
        });
      }
    }

    return {
      version: 1,
      scope: 'run',
      registryRevision: input.registryRevision,
      tools,
      nativeContracts,
      connections: connections.map(serializeAccessibleConnection),
      advisories,
    };
  }

  private listAccessibleConnections(
    principal: { readonly companyId: string; readonly userId: string },
    provider: ConnectionProvider,
  ) {
    return listAccessibleConnectionsFor(this.deps.connectionRegistry!, principal, provider);
  }
}

/**
 * The one provider→registry mapping. Exhaustive over `ConnectionProvider`, so a
 * new provider fails the build here rather than silently listing nothing.
 */
export function listAccessibleConnectionsFor(
  registry: ConnectionRegistryPort,
  principal: { readonly companyId: string; readonly userId: string },
  provider: ConnectionProvider,
) {
  const input = { companyId: principal.companyId, userId: principal.userId };
  switch (provider) {
    case 'google_workspace':
      return registry.listAccessibleGoogleConnections(input);
    case 'zoho':
      return registry.listAccessibleZohoConnections(input);
    case 'canva':
      return registry.listAccessibleCanvaConnections(input);
    case 'airtable':
      return registry.listAccessibleAirtableConnections(input);
    case 'lark':
      return registry.listAccessibleLarkConnections(input);
  }
}

export function connectionProvidersForToolIds(toolIds: readonly string[]): ConnectionProvider[] {
  const providers = new Set<ConnectionProvider>();
  for (const toolId of toolIds) {
    if (GOOGLE_WORKSPACE_TOOL_IDS.includes(toolId as (typeof GOOGLE_WORKSPACE_TOOL_IDS)[number])) {
      providers.add('google_workspace');
    } else if (toolId === 'zohoCrm' || toolId === 'zohoBooks') {
      providers.add('zoho');
    } else if (toolId === 'canvaDesign') {
      providers.add('canva');
    } else if (AIRTABLE_TOOL_IDS.includes(toolId)) {
      providers.add('airtable');
    } else if (LARK_CONNECTION_TOOL_IDS.has(toolId)) {
      providers.add('lark');
    }
  }
  return [...providers];
}

export function serializeAccessibleConnection(
  connection: AccessibleConnection,
): Record<string, unknown> {
  return {
    connectionId: connection.connectionId,
    provider: connection.provider,
    label: connection.label,
    accountEmail: connection.accountEmail ?? null,
    accountName: connection.accountName ?? null,
    ownerType: connection.ownerType,
    ownerUserId: connection.ownerUserId ?? null,
    access: connection.access,
    scopes: connection.scopes,
    connectedAt: connection.connectedAt.toISOString(),
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
  };
}
