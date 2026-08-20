import type { RunContext } from '../../../domain/orchestration/run-context';
import type { ProviderKey, ScopeGap } from '../../../domain/connections/scope-gap';

export type ConnectAskOutcome =
  | { readonly status: 'sent'; readonly intentId: string }
  | { readonly status: 'already_pending'; readonly intentId: string }
  | { readonly status: 'unreachable' };

export interface ConnectionRequestAdapter {
  classify(input: { readonly toolId: string; readonly error: unknown }): ScopeGap | undefined;
  request(input: { readonly gap: ScopeGap; readonly runContext: RunContext }): Promise<ConnectAskOutcome>;
}

/** The small interface callers use to classify and deliver connection asks. */
export class ConnectionRequestService {
  constructor(
    private readonly adapters: ReadonlyMap<ProviderKey, ConnectionRequestAdapter>,
  ) {}

  classify(input: {
    readonly provider: ProviderKey;
    readonly toolId: string;
    readonly error: unknown;
  }): ScopeGap | undefined {
    return this.adapters.get(input.provider)?.classify({
      toolId: input.toolId,
      error: input.error,
    });
  }

  async request(input: {
    readonly gap: ScopeGap;
    readonly runContext: RunContext;
  }): Promise<ConnectAskOutcome> {
    const adapter = this.adapters.get(input.gap.provider);
    if (!adapter) return { status: 'unreachable' };
    return adapter.request(input);
  }
}
