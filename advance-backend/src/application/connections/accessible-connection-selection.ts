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
  | { readonly status: 'unavailable' }
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
  readonly connectionId?: string;
  readonly minimumAccess: Exclude<ConnectionAccess, 'admin'>;
}): AccessibleConnectionSelection {
  const eligible = input.connections.filter(
    (connection) => ACCESS_RANK[connection.access] >= ACCESS_RANK[input.minimumAccess],
  );

  if (input.connectionId) {
    const selected = eligible.find((connection) => connection.connectionId === input.connectionId);
    return selected ? { status: 'selected', connection: selected } : { status: 'unavailable' };
  }
  if (eligible.length === 1) return { status: 'selected', connection: eligible[0]! };
  if (eligible.length > 1) return { status: 'choose_connection', connections: eligible };
  return { status: 'unavailable' };
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
