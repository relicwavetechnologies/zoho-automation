import type { AccessibleConnection } from '../connections/connection-registry.port';

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

export type WorkContractBootstrapMode = 'suggested' | 'complete' | 'complete_cached';

/**
 * Loads provider operation contracts selected for a resolved workflow.
 *
 * This is discovery-only context. It cannot invoke a provider operation or
 * grant account access; ToolExecutor remains authoritative for every call.
 */
export interface WorkContractBootstrapPort {
  load(input: {
    /**
     * Only the acting principal, deliberately not a channel-specific member
     * context: every caller must be able to supply this, and backend-hosted
     * channels have no gateway session to hand over.
     */
    readonly member: { readonly companyId: string; readonly userId: string };
    /**
     * `suggested` keeps the prompt-relevant subset. `complete` waits for every
     * provider-owned operation. `complete_cached` requests the same set but
     * returns describe-required misses while one durable refresh runs outside
     * the turn's critical path.
     */
    readonly contractMode?: WorkContractBootstrapMode;
    readonly query: string;
    readonly toolIds: readonly string[];
    readonly connections: readonly AccessibleConnection[];
    readonly abortSignal?: AbortSignal;
  }): Promise<WorkContractBootstrapResult>;
}
