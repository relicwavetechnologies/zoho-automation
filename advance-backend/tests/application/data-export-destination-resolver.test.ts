import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SCOPE } from '../../src/domain/google/google-workspace-scope.ts';
import { selectDataExportDestination } from '../../src/application/data-export/data-export-destination-resolver.ts';
import type { AccessibleConnection } from '../../src/application/connections/connection-registry.port.ts';

const connection = (
  connectionId: string,
  overrides: Partial<AccessibleConnection> = {},
): AccessibleConnection => ({
  connectionId,
  provider: 'google_workspace',
  label: `${connectionId}@example.com`,
  accountEmail: `${connectionId}@example.com`,
  ownerType: 'user',
  ownerUserId: 'user-1',
  access: 'admin',
  scopes: [GOOGLE_SCOPE.driveFile, GOOGLE_SCOPE.sheetsFull],
  connectedAt: new Date('2026-08-02T00:00:00.000Z'),
  ...overrides,
});

describe('data export destination selection', () => {
  it('prefers the only eligible user-owned writable account', () => {
    assert.deepEqual(selectDataExportDestination({
      userId: 'user-1',
      accessible: [connection('personal-1')],
      companyFallback: { connectionId: 'company-1' },
    }), {
      status: 'selected',
      target: { kind: 'user_google', connectionId: 'personal-1' },
    });
  });

  it('asks when several eligible personal accounts exist', () => {
    const result = selectDataExportDestination({
      userId: 'user-1',
      accessible: [connection('personal-1'), connection('personal-2')],
      companyFallback: { connectionId: 'company-1' },
    });

    assert.equal(result.status, 'choose_connection');
    assert.deepEqual(result.status === 'choose_connection'
      ? result.connections.map(choice => choice.connectionId)
      : [], ['personal-1', 'personal-2']);
  });

  it('uses the governed company fallback only when no personal account is eligible', () => {
    assert.deepEqual(selectDataExportDestination({
      userId: 'user-1',
      accessible: [connection('readonly', { access: 'read_only' })],
      companyFallback: { connectionId: 'company-1' },
    }), {
      status: 'selected',
      target: { kind: 'company_google', connectionId: 'company-1' },
    });
  });

  it('honours only an exact eligible personal account while one is available', () => {
    const accessible = [connection('personal-1')];
    assert.deepEqual(selectDataExportDestination({
      userId: 'user-1',
      accessible,
      companyFallback: { connectionId: 'company-1' },
      connectionId: 'personal-1',
    }), {
      status: 'selected',
      target: { kind: 'user_google', connectionId: 'personal-1' },
    });
    assert.equal(selectDataExportDestination({
      userId: 'user-1',
      accessible,
      companyFallback: { connectionId: 'company-1' },
      connectionId: 'company-1',
    }).status, 'unavailable');
    assert.equal(selectDataExportDestination({
      userId: 'user-1',
      accessible,
      connectionId: 'attacker-connection',
    }).status, 'unavailable');
  });

  it('accepts the configured company destination only when no personal account is eligible', () => {
    assert.deepEqual(selectDataExportDestination({
      userId: 'user-1',
      accessible: [],
      companyFallback: { connectionId: 'company-1' },
      connectionId: 'company-1',
    }), {
      status: 'selected',
      target: { kind: 'company_google', connectionId: 'company-1' },
    });
  });

  it('requests a connection when neither personal nor company output is available', () => {
    assert.deepEqual(selectDataExportDestination({
      userId: 'user-1',
      accessible: [],
    }), { status: 'connect_required' });
  });
});
