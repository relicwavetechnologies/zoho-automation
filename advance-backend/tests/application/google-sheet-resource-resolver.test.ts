import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SCOPE } from '../../src/domain/google/google-workspace-scope.ts';
import {
  GoogleSheetResourceResolver,
  type GoogleSheetResourceProbe,
} from '../../src/application/artifacts/google-sheet-resource-resolver.ts';
import type { GoogleSheetReference } from '../../src/application/artifacts/google-sheet-resource-reference.ts';
import { GoogleDriveXlsxResourceResolver } from '../../src/application/artifacts/google-drive-xlsx-resource-resolver.ts';
import type { GoogleDriveXlsxReference } from '../../src/application/artifacts/google-drive-xlsx-resource-reference.ts';
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

describe('GoogleDriveXlsxResourceResolver', () => {
  const workbook: GoogleDriveXlsxReference = {
    provider: 'google',
    kind: 'excel_workbook',
    resourceId: 'workbook-123',
    canonicalUrl: 'https://drive.google.com/file/d/workbook-123/view',
  };

  it('verifies exact XLSX metadata and returns a confirmation-only copy plan', async () => {
    const current = probe({
      getDriveFile: async ({ fileId }) => ({
        id: fileId,
        name: 'Forecast.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        trashed: false,
        capabilities: { canCopy: true, canDownload: true },
      }),
    });
    assert.deepEqual(await new GoogleDriveXlsxResourceResolver(current.value).resolve({
      userId: 'user-1',
      reference: workbook,
      accessible: [connection('personal')],
    }), {
      status: 'resolved',
      resource: {
        ...workbook,
        connectionId: 'personal',
        fileName: 'Forecast.xlsx',
        requiresConfirmation: true,
        conversion: 'new_google_sheet_copy',
      },
    });
  });

  it('rejects non-XLSX and copy-restricted Drive files without probing Sheets', async () => {
    for (const [metadata, status] of [
      [{ id: 'workbook-123', mimeType: 'application/pdf' }, 'wrong_type'],
      [{
        id: 'workbook-123',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        capabilities: { canCopy: true, canDownload: false },
      }, 'copy_restricted'],
    ] as const) {
      const current = probe({ getDriveFile: async () => metadata });
      assert.equal((await new GoogleDriveXlsxResourceResolver(current.value).resolve({
        userId: 'user-1',
        reference: workbook,
        accessible: [connection('personal')],
      })).status, status);
      assert.deepEqual(current.calls, []);
    }
  });
});
