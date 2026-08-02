import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { google } from 'googleapis';
import { GoogleDriveXlsxConversionAdapter } from '../../src/infrastructure/google/google-drive-xlsx-conversion.adapter.ts';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('GoogleDriveXlsxConversionAdapter', () => {
  it('reads exact source metadata, streams XLSX bytes, finds only an exact private job key, creates a new Sheet, and verifies its metadata', async t => {
    const getCalls: unknown[] = [];
    const listCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    let uploaded = Buffer.alloc(0);
    let tokenCalls = 0;
    t.mock.method(google, 'drive', () => ({
      files: {
        get: async (input: any, options?: any) => {
          getCalls.push({ input, options });
          if (input.alt === 'media') {
            return { data: (async function* () {
              yield new Uint8Array([1, 2]);
              yield new Uint8Array([3]);
            })() };
          }
          if (input.fileId === 'source-xlsx') {
            return {
              data: {
                id: 'source-xlsx',
                mimeType: XLSX_MIME_TYPE,
                trashed: false,
                capabilities: { canDownload: true, canCopy: true },
              },
            };
          }
          return {
            data: {
              id: 'new-sheet',
              mimeType: 'application/vnd.google-apps.spreadsheet',
              trashed: false,
              owners: [{ emailAddress: 'person@example.com' }],
              webViewLink: 'https://docs.google.com/spreadsheets/d/new-sheet/edit',
            },
          };
        },
        list: async (input: unknown) => {
          listCalls.push(input);
          return { data: { files: [{
            id: 'unrelated-sheet',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            appProperties: { divoXlsxConversionJobKey: 'different-job' },
          }] } };
        },
        create: async (input: any) => {
          createCalls.push(input);
          for await (const chunk of input.media.body) uploaded = Buffer.concat([uploaded, Buffer.from(chunk)]);
          return { data: { id: 'new-sheet' } };
        },
      },
    }) as any);
    const adapter = new GoogleDriveXlsxConversionAdapter(async input => {
      tokenCalls += 1;
      assert.deepEqual(input, {
        companyId: 'company-1',
        userId: 'user-1',
        connectionId: 'connection-1',
      });
      return 'access-token';
    });

    assert.deepEqual(await adapter.getSourceMetadata({
      companyId: 'company-1', userId: 'user-1', sourceConnectionId: 'connection-1', sourceFileId: 'source-xlsx',
    }), {
      id: 'source-xlsx',
      mimeType: XLSX_MIME_TYPE,
      trashed: false,
      capabilities: { canDownload: true, canCopy: true },
    });
    const download = await adapter.downloadXlsx({ companyId: 'company-1', userId: 'user-1', sourceConnectionId: 'connection-1', sourceFileId: 'source-xlsx' });
    assert.deepEqual([...await collect(download)], [1, 2, 3]);
    assert.equal(await adapter.findCreatedSheet({ companyId: 'company-1', userId: 'user-1', connectionId: 'connection-1', idempotencyKey: "job-'1" }), null);
    assert.deepEqual(await adapter.importXlsxAsNewSheet({
      connectionId: 'connection-1',
      companyId: 'company-1',
      userId: 'user-1',
      sourceFileId: 'source-xlsx',
      sourceTitle: 'Quarterly budget.xlsx',
      idempotencyKey: "job-'1",
      content: (async function* () { yield new Uint8Array([4, 5, 6]); })(),
    }), { spreadsheetId: 'new-sheet' });
    assert.deepEqual(await adapter.getCreatedSheetMetadata({
      companyId: 'company-1', userId: 'user-1', connectionId: 'connection-1', spreadsheetId: 'new-sheet',
    }), {
      id: 'new-sheet',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      trashed: false,
      ownerEmail: 'person@example.com',
      webViewLink: 'https://docs.google.com/spreadsheets/d/new-sheet/edit',
    });

    assert.equal(tokenCalls, 5);
    assert.deepEqual(getCalls, [
      {
        input: {
          fileId: 'source-xlsx',
          supportsAllDrives: true,
          fields: 'id,mimeType,trashed,capabilities(canDownload,canCopy)',
        },
        options: undefined,
      },
      {
        input: { fileId: 'source-xlsx', alt: 'media', supportsAllDrives: true },
        options: { responseType: 'stream' },
      },
      {
        input: {
          fileId: 'new-sheet',
          supportsAllDrives: true,
          fields: 'id,mimeType,trashed,owners(emailAddress),webViewLink',
        },
        options: undefined,
      },
    ]);
    assert.deepEqual(listCalls, [{
      q: "appProperties has { key='divoXlsxConversionJobKey' and value='job-\\'1' } and trashed = false",
      pageSize: 2,
      fields: 'files(id,mimeType,trashed,appProperties)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }]);
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0], {
      ignoreDefaultVisibility: true,
      supportsAllDrives: true,
      requestBody: {
        name: 'Quarterly budget',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        appProperties: { divoXlsxConversionJobKey: "job-'1" },
      },
      media: { mimeType: XLSX_MIME_TYPE, body: createCalls[0].media.body },
      fields: 'id',
    });
    assert.deepEqual([...uploaded], [4, 5, 6]);
  });
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
