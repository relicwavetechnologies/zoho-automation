import {
  selectAccessibleConnection,
  type AccessibleConnectionSelection,
} from '../connections/accessible-connection-selection';
import type { AccessibleConnection, ConnectionAccess } from '../connections/connection-registry.port';
import { CONNECTION_NEEDS_KEY } from '../../infrastructure/persistence/integration-connection.repository';

/**
 * Which AITable account a call should use.
 *
 * This exists as its own function because AITable has one outcome no OAuth
 * provider has: a connection that exists, is shared correctly, and still cannot
 * be used, because the API key behind it was regenerated in AITable's User
 * Center and nothing here can refresh it.
 *
 * Folding that into `unavailable` would reproduce a falsehood this codebase has
 * already been bitten by once — telling a member they have no account when what
 * they actually have is an account needing attention.
 */
export type AitableSelection =
  | { readonly status: 'selected'; readonly connection: AccessibleConnection }
  | { readonly status: 'choose_connection'; readonly connections: readonly AccessibleConnection[] }
  /** Every account the caller could have used is waiting for a new key. */
  | { readonly status: 'needs_key'; readonly connections: readonly AccessibleConnection[] }
  | { readonly status: 'unavailable' };

/**
 * Re-exported, not redeclared. The status is a persistence value, and a second
 * copy of the literal here would silently stop matching the day the column
 * changed.
 */
export const AITABLE_NEEDS_KEY = CONNECTION_NEEDS_KEY;

export function selectAitableConnection(input: {
  readonly connections: readonly AccessibleConnection[];
  readonly connectionId?: string;
  readonly minimumAccess: Exclude<ConnectionAccess, 'admin'>;
}): AitableSelection {
  const live = input.connections.filter(connection => connection.status !== AITABLE_NEEDS_KEY);
  const stale = input.connections.filter(connection => connection.status === AITABLE_NEEDS_KEY);

  // Stale accounts are declared rather than dropped. The shared selector uses
  // `filteredOut` only to tell "nothing eligible" apart from "nothing at all",
  // which is exactly the distinction being preserved here.
  const selection: AccessibleConnectionSelection = selectAccessibleConnection({
    connections: live,
    filteredOut: stale,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    minimumAccess: input.minimumAccess,
  });

  if (selection.status === 'selected') return { status: 'selected', connection: selection.connection };
  if (selection.status === 'choose_connection') {
    return { status: 'choose_connection', connections: selection.connections };
  }

  // An explicitly requested account that is stale reports itself, rather than
  // the whole set: the caller named one, so answering about a different one
  // would be a non-sequitur.
  if (input.connectionId) {
    const requested = stale.find(connection => connection.connectionId === input.connectionId);
    return requested
      ? { status: 'needs_key', connections: [requested] }
      : { status: 'unavailable' };
  }
  return stale.length > 0
    ? { status: 'needs_key', connections: stale }
    : { status: 'unavailable' };
}
