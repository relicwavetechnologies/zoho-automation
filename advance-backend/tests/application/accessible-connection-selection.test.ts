import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  selectAccessibleConnection,
} from '../../src/application/connections/accessible-connection-selection';
import type { AccessibleConnection } from '../../src/application/connections/connection-registry.port';

function connection(
  connectionId: string,
  access: AccessibleConnection['access'],
): AccessibleConnection {
  return {
    connectionId,
    provider: 'google_workspace',
    label: connectionId,
    ownerType: 'user',
    access,
    scopes: [],
    connectedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('provider-neutral accessible connection selection', () => {
  it('selects the sole eligible connection without model choice', () => {
    const result = selectAccessibleConnection({
      connections: [connection('read', 'read_only'), connection('write', 'read_write')],
      minimumAccess: 'read_write',
    });
    assert.equal(result.status, 'selected');
    assert.equal(result.status === 'selected' && result.connection.connectionId, 'write');
  });

  it('returns every eligible option instead of guessing when ambiguous', () => {
    const result = selectAccessibleConnection({
      connections: [connection('first', 'read_only'), connection('second', 'admin')],
      minimumAccess: 'read_only',
    });
    assert.equal(result.status, 'choose_connection');
    assert.deepEqual(
      result.status === 'choose_connection'
        ? result.connections.map((item) => item.connectionId)
        : [],
      ['first', 'second'],
    );
  });

  it('never accepts an inaccessible or underprivileged explicit ID', () => {
    assert.equal(selectAccessibleConnection({
      connections: [connection('read', 'read_only')],
      connectionId: 'read',
      minimumAccess: 'read_write',
    }).status, 'unavailable');
    assert.equal(selectAccessibleConnection({
      connections: [connection('read', 'read_only')],
      connectionId: 'unknown',
      minimumAccess: 'read_only',
    }).status, 'unavailable');
  });
});
