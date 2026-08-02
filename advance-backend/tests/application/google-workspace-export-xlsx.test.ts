import { it } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { GoogleWorkspaceExportSink } from '../../src/application/data-export/google-workspace-export.sink.ts';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

it('recovers a verified XLSX when the completion metadata response is lost', async t => {
  let completedProperties: Record<string, string> | undefined;
  let uploadedSize = 0;
  let deletedFiles = 0;
  let sourceReads = 0;
  const drive = {
    files: {
      list: async () => ({
        data: {
          files: completedProperties
            ? [{
                id: 'xlsx-1',
                mimeType: XLSX_MIME,
                webViewLink: 'https://drive.google.com/file/d/xlsx-1/view',
                appProperties: completedProperties,
              }]
            : [],
        },
      }),
      create: async (input: any) => {
        assert.equal(input.requestBody.name, 'Quarterly invoices.xlsx');
        assert.equal(input.requestBody.mimeType, XLSX_MIME);
        assert.equal(input.media.mimeType, XLSX_MIME);
        for await (const chunk of input.media.body) {
          uploadedSize += Buffer.byteLength(chunk);
        }
        return { data: { id: 'xlsx-1' } };
      },
      get: async () => ({
        data: {
          id: 'xlsx-1',
          size: String(uploadedSize),
          mimeType: XLSX_MIME,
          webViewLink: 'https://drive.google.com/file/d/xlsx-1/view',
        },
      }),
      update: async (input: any) => {
        completedProperties = input.requestBody.appProperties;
        throw new Error('Drive completion response was lost');
      },
      delete: async () => {
        deletedFiles += 1;
      },
    },
    permissions: {
      list: async () => ({
        data: {
          permissions: [
            { type: 'user', role: 'owner', emailAddress: 'member@gmail.com' },
          ],
        },
      }),
      create: async () => assert.fail('owner export must not create a reader permission'),
    },
  };
  t.mock.method(google, 'drive', () => drive as any);

  const sink = new GoogleWorkspaceExportSink();
  const input = {
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'job-xlsx',
    destination: { format: 'xlsx' as const, title: 'Quarterly invoices' },
    rows: (async function* () {
      sourceReads += 1;
      yield [{ invoice: 'INV-1', amount: 25 }];
    })(),
    sourceTruncated: () => false,
  };

  await assert.rejects(sink.write(input), /completion response was lost/i);
  assert.equal(deletedFiles, 0, 'ambiguous completion must preserve the verified file');

  const recovered = await sink.write({
    ...input,
    rows: (async function* () {
      assert.fail('retry must recover without reading source rows');
    })(),
  });

  assert.equal(sourceReads, 1);
  assert.equal(recovered.artifactType, 'xlsx');
  assert.equal(recovered.artifactId, 'xlsx-1');
  assert.equal(recovered.verified, true);
});
