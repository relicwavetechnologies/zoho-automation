import type {
  WorkContractBootstrapResult,
  WorkNativeContract,
} from './work-contract-bootstrap.port';

const CONTRACT_LOAD_CONCURRENCY = 2;

/**
 * Load independent provider-owned schemas without turning one slow description
 * into a serial wait for every description after it.
 *
 * Results retain request order so generated Pi contracts stay deterministic.
 * One failed description remains one unavailable native tool; cancellation is
 * the only failure that stops the whole load.
 */
export async function loadWorkNativeContracts<T extends { readonly nativeTool: string }>(
  requested: readonly T[],
  load: (item: T) => Promise<WorkNativeContract | null>,
  abortSignal?: AbortSignal,
): Promise<WorkContractBootstrapResult> {
  if (requested.length === 0) return { contracts: [], unavailableNativeTools: [] };
  const results: Array<WorkNativeContract | null | undefined> = new Array(requested.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < requested.length) {
      abortSignal?.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await load(requested[index]!);
        abortSignal?.throwIfAborted();
      } catch {
        abortSignal?.throwIfAborted();
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(CONTRACT_LOAD_CONCURRENCY, requested.length) },
    worker,
  ));
  abortSignal?.throwIfAborted();

  const contracts: WorkNativeContract[] = [];
  const unavailableNativeTools: string[] = [];
  for (const [index, item] of requested.entries()) {
    const contract = results[index];
    if (contract) contracts.push(contract);
    else unavailableNativeTools.push(item.nativeTool);
  }
  return { contracts, unavailableNativeTools };
}
