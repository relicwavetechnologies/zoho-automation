import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { GoogleSheetResourceProbeClient } from '../../src/infrastructure/google/google-sheet-resource-probe.ts';

describe('GoogleSheetResourceProbeClient', () => {
  it('uses one request-bound token and probes the exact Drive and Sheets metadata', async t => {
    const driveCalls: unknown[] = [];
    const sheetsCalls: unknown[] = [];
    let tokenCalls = 0;
    t.mock.method(google, 'drive', () => ({
      files: {
        get: async (input: unknown) => {
          driveCalls.push(input);
          return {
            data: {
              id: 'sheet-1',
              mimeType: 'application/vnd.google-apps.spreadsheet',
              trashed: false,
              capabilities: { canEdit: true },
            },
          };
        },
      },
    }) as any);
    t.mock.method(google, 'sheets', () => ({
      spreadsheets: {
        get: async (input: unknown) => {
          sheetsCalls.push(input);
          return { data: { spreadsheetId: 'sheet-1' } };
        },
      },
    }) as any);

    const probe = new GoogleSheetResourceProbeClient(async () => {
      tokenCalls += 1;
      return 'access-token';
    });

    assert.deepEqual(await probe.getDriveFile({ connectionId: 'connection-1', fileId: 'sheet-1' }), {
      id: 'sheet-1',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      trashed: false,
      capabilities: { canEdit: true },
    });
    assert.deepEqual(await probe.getSpreadsheet({ connectionId: 'connection-1', spreadsheetId: 'sheet-1' }), {
      spreadsheetId: 'sheet-1',
    });
    assert.equal(tokenCalls, 1);
    assert.deepEqual(driveCalls, [{
      fileId: 'sheet-1',
      supportsAllDrives: true,
      fields: 'id,mimeType,trashed,capabilities(canEdit)',
    }]);
    assert.deepEqual(sheetsCalls, [{ spreadsheetId: 'sheet-1', fields: 'spreadsheetId' }]);
  });

  it('maps only provider 403/404 to inaccessible and propagates other failures', async t => {
    const providerError = (status: number) => Object.assign(new Error(`HTTP ${status}`), {
      response: { status },
    });
    let driveError: Error = providerError(403);
    let sheetsError: Error = providerError(404);
    t.mock.method(google, 'drive', () => ({
      files: { get: async () => { throw driveError; } },
    }) as any);
    t.mock.method(google, 'sheets', () => ({
      spreadsheets: { get: async () => { throw sheetsError; } },
    }) as any);
    const probe = new GoogleSheetResourceProbeClient(async () => 'access-token');

    assert.equal(await probe.getDriveFile({ connectionId: 'connection-1', fileId: 'sheet-1' }), null);
    assert.equal(await probe.getSpreadsheet({ connectionId: 'connection-1', spreadsheetId: 'sheet-1' }), null);

    driveError = providerError(401);
    await assert.rejects(
      probe.getDriveFile({ connectionId: 'connection-1', fileId: 'sheet-1' }),
      /HTTP 401/,
    );
    sheetsError = providerError(429);
    await assert.rejects(
      probe.getSpreadsheet({ connectionId: 'connection-1', spreadsheetId: 'sheet-1' }),
      /HTTP 429/,
    );
    driveError = providerError(500);
    await assert.rejects(
      probe.getDriveFile({ connectionId: 'connection-1', fileId: 'sheet-1' }),
      /HTTP 500/,
    );
  });
});
