import type { RunContext } from '../../../domain/orchestration/run-context';
import type { ProviderKey, ScopeGap } from '../../../domain/connections/scope-gap';

export type ConnectAskOutcome =
  /** ISO-8601. How long the member has, and therefore how long the run waits. */
  | { readonly status: 'sent'; readonly intentId: string; readonly expiresAt?: string }
  | { readonly status: 'already_pending'; readonly intentId: string; readonly expiresAt?: string }
  | { readonly status: 'unreachable' };

export const CONNECTION_ASK_SENT_CODE = 'connection_ask_sent' as const;
/**
 * Read by the run that is about to stand still, not by the model.
 *
 * The run no longer ends here. It blocks on the Connect ask and picks up where
 * it left off once the member has finished, so the instruction this used to
 * carry ("end this run") would now be wrong.
 */
export const CONNECTION_ASK_SENT_MESSAGE =
  'A connection ask was sent to the member. This run waits for them to finish it.';

export interface ConnectionAskSentResult {
  readonly success: false;
  readonly code: typeof CONNECTION_ASK_SENT_CODE;
  readonly intentId: string;
  readonly provider: ProviderKey;
  readonly expiresAt?: string;
  readonly message: typeof CONNECTION_ASK_SENT_MESSAGE;
}

export function connectionAskSentResult(
  provider: ProviderKey,
  outcome: ConnectAskOutcome,
): ConnectionAskSentResult | undefined {
  if (outcome.status === 'unreachable') return undefined;
  return {
    success: false,
    code: CONNECTION_ASK_SENT_CODE,
    intentId: outcome.intentId,
    provider,
    ...(outcome.expiresAt ? { expiresAt: outcome.expiresAt } : {}),
    message: CONNECTION_ASK_SENT_MESSAGE,
  };
}

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
