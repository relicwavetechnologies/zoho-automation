import type { ConnectionProvider } from './connection-provider';

/** Canonical provider key used by the connection-request module. */
export type ProviderKey = ConnectionProvider;

export type ScopeGapReason = 'not_connected' | 'insufficient_scope';

/** A provider failure reduced to the next action the product can take. */
export interface ScopeGap {
  readonly provider: ProviderKey;
  readonly toolId: string;
  readonly missingScopeGroups: readonly (readonly string[])[];
  readonly reason: ScopeGapReason;
}
