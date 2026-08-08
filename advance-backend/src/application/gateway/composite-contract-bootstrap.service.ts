import type {
  WorkContractBootstrapPort,
  WorkContractBootstrapResult,
  WorkNativeContract,
} from './work-contract-bootstrap.port';

/**
 * Fans one bootstrap request out across every provider that can contribute
 * native contracts.
 *
 * Each delegate is isolated: a provider whose schema load fails reports its own
 * operations as unavailable instead of blanking the contracts another provider
 * already resolved. Cancellation is the one failure that still propagates,
 * because an aborted run must not keep loading schemas nobody will read.
 */
export class CompositeWorkContractBootstrap implements WorkContractBootstrapPort {
  private readonly delegates: readonly WorkContractBootstrapPort[];

  constructor(delegates: readonly WorkContractBootstrapPort[]) {
    this.delegates = delegates;
  }

  async load(input: Parameters<WorkContractBootstrapPort['load']>[0]): Promise<WorkContractBootstrapResult> {
    input.abortSignal?.throwIfAborted();

    const results = await Promise.all(this.delegates.map(async (delegate) => {
      try {
        return await delegate.load(input);
      } catch (cause) {
        input.abortSignal?.throwIfAborted();
        if (cause instanceof Error && cause.name === 'AbortError') throw cause;
        return { contracts: [], unavailableNativeTools: [] } satisfies WorkContractBootstrapResult;
      }
    }));
    input.abortSignal?.throwIfAborted();

    const contracts: WorkNativeContract[] = [];
    const seen = new Set<string>();
    const unavailableNativeTools = new Set<string>();
    for (const result of results) {
      for (const contract of result.contracts) {
        const key = `${contract.toolId}:${contract.nativeTool}`;
        if (seen.has(key)) continue;
        seen.add(key);
        contracts.push(contract);
      }
      for (const nativeTool of result.unavailableNativeTools) unavailableNativeTools.add(nativeTool);
    }
    return { contracts, unavailableNativeTools: [...unavailableNativeTools] };
  }
}
