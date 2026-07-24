import type { AccessibleConnection } from '../connections/connection-registry.port';
import type { GatewayMemberContext } from './gateway.types';

export interface WorkNativeContract {
  readonly toolId: string;
  readonly nativeTool: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface WorkContractBootstrapResult {
  readonly contracts: readonly WorkNativeContract[];
  readonly unavailableNativeTools: readonly string[];
}

/**
 * Loads provider operation contracts selected for a resolved workflow.
 *
 * This is discovery-only context. It cannot invoke a provider operation or
 * grant account access; ToolExecutor remains authoritative for every call.
 */
export interface WorkContractBootstrapPort {
  load(input: {
    readonly member: GatewayMemberContext;
    readonly query: string;
    readonly toolIds: readonly string[];
    readonly connections: readonly AccessibleConnection[];
  }): Promise<WorkContractBootstrapResult>;
}
