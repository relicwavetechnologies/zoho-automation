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

  it('distinguishes a wrong ID from having no account at all', () => {
    // These two are not the same answer. A member who named an account he
    // cannot reach should be corrected and shown the ones he can; a member with
    // nothing connected should be asked to connect one. A live run collapsed
    // them and told a member his Google account was not connected while he held
    // a read-only grant on one.
    const wrongId = selectAccessibleConnection({
      connections: [connection('granted', 'read_only')],
      connectionId: 'guessed-uuid',
      minimumAccess: 'read_only',
    });
    assert.equal(wrongId.status === 'unavailable' && wrongId.reason, 'requested_not_accessible');
    assert.deepEqual(
      wrongId.status === 'unavailable' ? wrongId.accessible.map((item) => item.connectionId) : [],
      ['granted'],
    );

    const nothing = selectAccessibleConnection({
      connections: [],
      connectionId: 'guessed-uuid',
      minimumAccess: 'read_only',
    });
    assert.equal(nothing.status === 'unavailable' && nothing.reason, 'none_accessible');
    assert.deepEqual(nothing.status === 'unavailable' ? nothing.accessible : null, []);
  });

  it('counts caller-filtered accounts as reachable when judging absence', () => {
    // The live regression. Google filters by scope group before selecting, so
    // a member whose only shared account has `gmail.readonly` presents as zero
    // connections the moment a run needs `gmail.send`. Judged on that alone the
    // verdict is "no account connected — do not retry", which is false and is
    // exactly what Divo told a member who did have one.
    const scopeShort = connection('shared-readonly', 'read_only');
    const result = selectAccessibleConnection({
      connections: [],
      filteredOut: [scopeShort],
      minimumAccess: 'read_only',
    });
    assert.equal(result.status === 'unavailable' && result.reason, 'insufficient_access');

    // And when the model names that very account, it is his — just unusable here.
    const named = selectAccessibleConnection({
      connections: [],
      filteredOut: [scopeShort],
      connectionId: 'shared-readonly',
      minimumAccess: 'read_only',
    });
    assert.equal(named.status === 'unavailable' && named.reason, 'insufficient_access');
  });

  it('still reports genuine absence when nothing was filtered', () => {
    const result = selectAccessibleConnection({
      connections: [],
      filteredOut: [],
      minimumAccess: 'read_only',
    });
    assert.equal(result.status === 'unavailable' && result.reason, 'none_accessible');
  });

  it('reports an underprivileged account as too weak, not absent', () => {
    // The account exists and is shared; it is only too weak for this action.
    // Saying "none connected" would send the user to connect one they have.
    const named = selectAccessibleConnection({
      connections: [connection('read', 'read_only')],
      connectionId: 'read',
      minimumAccess: 'read_write',
    });
    assert.equal(named.status === 'unavailable' && named.reason, 'insufficient_access');

    // Same when no ID was named at all and nothing clears the bar.
    const unnamed = selectAccessibleConnection({
      connections: [connection('read', 'read_only')],
      minimumAccess: 'read_write',
    });
    assert.equal(unnamed.status === 'unavailable' && unnamed.reason, 'insufficient_access');
  });
});
