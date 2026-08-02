import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SCOPE } from '../../src/domain/google/google-workspace-scope.ts';
import {
  GoogleSheetResourceResolver,
  type GoogleSheetResourceProbe,
} from '../../src/application/data-export/google-sheet-resource-resolver.ts';
import type { GoogleSheetReference } from '../../src/application/data-export/google-sheet-resource-reference.ts';
import type { AccessibleConnection } from '../../src/application/connections/connection-registry.port.ts';

const spreadsheetId = 'sheet_123-AbC';
const reference: GoogleSheetReference = {
  provider: 'google',
  kind: 'spreadsheet',
  resourceId: spreadsheetId,
  subresourceId: '12',
  canonicalUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=12`,
};

const connection = (
  connectionId: string,
  overrides: Partial<AccessibleConnection> = {},
): AccessibleConnection => ({
  connectionId,
  provider: 'google_workspace',
  label: connectionId,
  ownerType: 'user',
  ownerUserId: 'user-1',
  access: 'admin',
  scopes: [GOOGLE_SCOPE.driveFull, GOOGLE_SCOPE.sheetsFull],
  connectedAt: new Date('2026-08-02T00:00:00.000Z'),
  ...overrides,
});

function probe(overrides: Partial<GoogleSheetResourceProbe> = {}) {
  const calls: string[] = [];
  const value: GoogleSheetResourceProbe = {
    getDriveFile: async ({ connectionId, fileId }) => {
      calls.push(`drive:${connectionId}:${fileId}`);
      return {
        id: fileId,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        trashed: false,
        capabilities: { canEdit: true },
      };
    },
    getSpreadsheet: async ({ connectionId, spreadsheetId: id }) => {
      calls.push(`sheets:${connectionId}:${id}`);
      return { spreadsheetId: id };
    },
    ...overrides,
  };
  return { value, calls };
}

describe('GoogleSheetResourceResolver', () => {
  it('does not probe company, foreign, read-only, or insufficient-scope connections', async () => {
    const first = probe();
    const resolver = new GoogleSheetResourceResolver(first.value);

    assert.deepEqual(await resolver.resolve({
      userId: 'user-1',
      reference,
      accessible: [
        connection('company', { ownerType: 'company' }),
        connection('foreign', { ownerUserId: 'user-2' }),
        connection('read-only', { access: 'read_only' }),
      ],
    }), { status: 'no_connection' });
    assert.deepEqual(first.calls, []);

    assert.deepEqual(await resolver.resolve({
      userId: 'user-1',
      reference,
      accessible: [connection('readonly-scope', { scopes: [GOOGLE_SCOPE.sheetsFull] })],
    }), { status: 'missing_scope' });
    assert.deepEqual(first.calls, []);

    assert.deepEqual(resolver.listEligible({
      userId: 'user-1',
      accessible: [connection('personal', { accountEmail: 'user@example.com' })],
    }), {
      status: 'choose_connection',
      connections: [{
        connectionId: 'personal',
        label: 'personal',
        accountEmail: 'user@example.com',
      }],
    });
    assert.deepEqual(first.calls, []);
  });

  it('returns distinct Drive access outcomes before querying Sheets', async () => {
    for (const [metadata, status] of [
      [null, 'inaccessible'],
      [{ id: spreadsheetId, trashed: true }, 'trashed'],
      [{ id: spreadsheetId, mimeType: 'text/plain', capabilities: { canEdit: true } }, 'wrong_type'],
      [{ id: spreadsheetId, mimeType: 'application/vnd.google-apps.spreadsheet', capabilities: { canEdit: false } }, 'read_only'],
    ] as const) {
      const current = probe({ getDriveFile: async () => metadata });
      const result = await new GoogleSheetResourceResolver(current.value).resolve({
        userId: 'user-1',
        reference,
        accessible: [connection('personal')],
      });
      assert.equal(result.status, status);
      assert.deepEqual(current.calls, []);
    }
  });

  it('probes Drive then Sheets and requires an explicit choice for multiple writable accounts', async () => {
    const one = probe();
    const resolver = new GoogleSheetResourceResolver(one.value);
    assert.deepEqual(await resolver.resolve({
      userId: 'user-1',
      reference,
      accessible: [connection('personal')],
    }), {
      status: 'resolved',
      resource: {
        ...reference,
        connectionId: 'personal',
      },
    });
    assert.deepEqual(one.calls, [
      `drive:personal:${spreadsheetId}`,
      `sheets:personal:${spreadsheetId}`,
    ]);

    const many = probe();
    assert.deepEqual(await new GoogleSheetResourceResolver(many.value).resolve({
      userId: 'user-1',
      reference,
      accessible: [connection('first'), connection('second')],
    }), {
      status: 'choose_connection',
      connections: [
        { connectionId: 'first', label: 'first' },
        { connectionId: 'second', label: 'second' },
      ],
    });
  });
});
