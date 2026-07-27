import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectAitableConnection,
  AITABLE_NEEDS_KEY,
} from '../../src/application/aitable/aitable-connection-selection.ts';
import { CONNECTION_NEEDS_KEY } from '../../src/infrastructure/persistence/integration-connection.repository.ts';
import type { AccessibleConnection } from '../../src/application/connections/connection-registry.port.ts';

const connection = (
  connectionId: string,
  overrides: Partial<AccessibleConnection> = {},
): AccessibleConnection => ({
  connectionId,
  provider: 'aitable',
  label: `Workspace ${connectionId}`,
  ownerType: 'user',
  ownerUserId: 'user-1',
  access: 'admin',
  scopes: [],
  connectedAt: new Date('2026-07-01T00:00:00Z'),
  status: 'connected',
  ...overrides,
});

const dead = (connectionId: string) => connection(connectionId, { status: AITABLE_NEEDS_KEY });

describe('AITable connection selection', () => {
  it('auto-selects when exactly one live account is reachable', () => {
    const result = selectAitableConnection({
      connections: [connection('c1')],
      minimumAccess: 'read_only',
    });

    assert.equal(result.status, 'selected');
    assert.equal(result.status === 'selected' && result.connection.connectionId, 'c1');
  });

  // Several keys per company is the expected shape here, not an edge case:
  // AITable keys are personal, so an account picker is normal traffic.
  it('asks which account to use when more than one is live', () => {
    const result = selectAitableConnection({
      connections: [connection('c1'), connection('c2'), connection('c3')],
      minimumAccess: 'read_write',
    });

    assert.equal(result.status, 'choose_connection');
    assert.deepEqual(
      result.status === 'choose_connection' ? result.connections.map(c => c.connectionId) : [],
      ['c1', 'c2', 'c3'],
    );
  });

  it('honours an explicitly named account instead of asking', () => {
    const result = selectAitableConnection({
      connections: [connection('c1'), connection('c2')],
      connectionId: 'c2',
      minimumAccess: 'read_only',
    });

    assert.equal(result.status === 'selected' && result.connection.connectionId, 'c2');
  });

  // The whole reason this function exists. An account whose key died is not the
  // same as no account, and reporting it as such is the falsehood being
  // designed against.
  it('reports a dead key as needing repair, never as "no account"', () => {
    const result = selectAitableConnection({
      connections: [dead('c1')],
      minimumAccess: 'read_only',
    });

    assert.equal(result.status, 'needs_key');
    assert.deepEqual(
      result.status === 'needs_key' ? result.connections.map(c => c.connectionId) : [],
      ['c1'],
    );
  });

  it('says nothing is available only when nothing is', () => {
    assert.equal(selectAitableConnection({ connections: [], minimumAccess: 'read_only' }).status, 'unavailable');
  });

  // A dead account must not shoulder its way into a decision that a working
  // account can answer on its own.
  it('ignores a dead account when a live one can serve the call', () => {
    const result = selectAitableConnection({
      connections: [dead('dead-1'), connection('live-1')],
      minimumAccess: 'read_only',
    });

    assert.equal(result.status === 'selected' && result.connection.connectionId, 'live-1');
  });

  it('does not offer a dead account among the choices', () => {
    const result = selectAitableConnection({
      connections: [connection('c1'), dead('dead-1'), connection('c2')],
      minimumAccess: 'read_only',
    });

    assert.equal(result.status, 'choose_connection');
    assert.deepEqual(
      result.status === 'choose_connection' ? result.connections.map(c => c.connectionId) : [],
      ['c1', 'c2'],
    );
  });

  // The caller named one account, so the answer is about that account. Handing
  // back the full stale list would answer a question nobody asked.
  it('answers about the account that was actually named', () => {
    const result = selectAitableConnection({
      connections: [dead('asked-for'), dead('other')],
      connectionId: 'asked-for',
      minimumAccess: 'read_only',
    });

    assert.equal(result.status, 'needs_key');
    assert.deepEqual(
      result.status === 'needs_key' ? result.connections.map(c => c.connectionId) : [],
      ['asked-for'],
    );
  });

  it('reports an unknown connection ID as unavailable, not as needing a key', () => {
    const result = selectAitableConnection({
      connections: [dead('c1')],
      connectionId: 'never-existed',
      minimumAccess: 'read_only',
    });

    assert.equal(result.status, 'unavailable');
  });

  // A read-only grant cannot serve a write. This is the shared selector's job,
  // asserted here so partitioning by status never quietly bypasses it.
  it('still enforces the access floor', () => {
    const result = selectAitableConnection({
      connections: [connection('c1', { access: 'read_only' })],
      minimumAccess: 'read_write',
    });

    assert.equal(result.status, 'unavailable');
  });

  it('keeps the status literal identical to the one persistence writes', () => {
    assert.equal(AITABLE_NEEDS_KEY, CONNECTION_NEEDS_KEY);
  });
});
