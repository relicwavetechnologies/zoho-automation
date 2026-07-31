import type {
  AccessibleConnection,
  ConnectionAccess,
} from './connection-registry.port';

const ACCESS_RANK: Readonly<Record<ConnectionAccess, number>> = {
  read_only: 1,
  read_write: 2,
  admin: 3,
};

export type AccessibleConnectionSelection =
  | { readonly status: 'selected'; readonly connection: AccessibleConnection }
  /**
   * Three different failures that used to look identical, each needing a
   * different answer from the one above it:
   *
   * - `none_accessible` — nothing is connected or shared. Ask the user to
   *   connect an account.
   * - `insufficient_access` — an account is there but too weak for this action.
   *   Ask for a stronger grant; telling them to connect one they already have
   *   sends them in a circle.
   * - `requested_not_accessible` — a specific ID was named that is not theirs.
   *   Correct the caller and list the real ones.
   *
   * Collapsing these produced a live run where Divo told a member his Google
   * account was not connected while he held a read-only grant on one.
   */
  | {
      readonly status: 'unavailable';
      readonly reason: 'none_accessible' | 'insufficient_access' | 'requested_not_accessible';
      readonly accessible: readonly AccessibleConnection[];
    }
  | { readonly status: 'choose_connection'; readonly connections: readonly AccessibleConnection[] };

/**
 * Provider-neutral account selection policy.
 *
 * An explicit ID must still be accessible and strong enough for the action.
 * Without an ID, the backend auto-selects only when exactly one eligible
 * connection exists; ambiguity is returned as data and is never guessed.
 */
export function selectAccessibleConnection(input: {
  readonly connections: readonly AccessibleConnection[];
  /**
   * Accounts the caller removed before calling, for provider rules this policy
   * cannot evaluate — Google scope groups, for instance.
   *
   * They must still be declared, because "nothing eligible" means something
   * different when they exist. Filtering silently is what let a member holding
   * a `gmail.readonly` grant be told he had no Google account at all the moment
   * a run needed `gmail.send`.
   */
  readonly filteredOut?: readonly AccessibleConnection[];
  readonly connectionId?: string;
  readonly minimumAccess: Exclude<ConnectionAccess, 'admin'>;
}): AccessibleConnectionSelection {
  const eligible = input.connections.filter(
    (connection) => ACCESS_RANK[connection.access] >= ACCESS_RANK[input.minimumAccess],
  );
  // Everything the member can actually reach, including what the caller
  // pre-filtered. Only this set can answer "has he got an account at all?".
  const reachable = [...input.connections, ...(input.filteredOut ?? [])];

  if (input.connectionId) {
    const selected = eligible.find((connection) => connection.connectionId === input.connectionId);
    if (selected) return { status: 'selected', connection: selected };
    // Present but unusable is a different problem from not theirs at all, so
    // the requested ID is checked against everything reachable rather than only
    // the accounts strong enough for this action.
    const exists = reachable.some(
      (connection) => connection.connectionId === input.connectionId,
    );
    return {
      status: 'unavailable',
      reason: exists
        ? 'insufficient_access'
        : reachable.length > 0 ? 'requested_not_accessible' : 'none_accessible',
      accessible: eligible,
    };
  }
  if (eligible.length === 1) return { status: 'selected', connection: eligible[0]! };
  if (eligible.length > 1) return { status: 'choose_connection', connections: eligible };
  return {
    status: 'unavailable',
    reason: reachable.length > 0 ? 'insufficient_access' : 'none_accessible',
    accessible: [],
  };
}

export function publicConnectionChoices(connections: readonly AccessibleConnection[]) {
  return connections.map((connection) => ({
    connectionId: connection.connectionId,
    label: connection.label,
    ...(connection.accountEmail ? { accountEmail: connection.accountEmail } : {}),
    ...(connection.accountName ? { accountName: connection.accountName } : {}),
    access: connection.access,
  }));
}
