import { it } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { GoogleWorkspaceExportSink } from '../../src/application/data-export/google-workspace-export.sink.ts';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

it('recovers a verified XLSX when the completion metadata response is lost', async t => {
  let completedProperties: Record<string, string> | undefined;
  let lostCompletionResponse = true;
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
        if (
          input.requestBody.appProperties.divoExportState === 'complete'
          && lostCompletionResponse
        ) {
          lostCompletionResponse = false;
          throw new Error('Drive completion response was lost');
        }
        completedProperties = input.requestBody.appProperties;
        return { data: { id: 'xlsx-1' } };
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

it('delivers an explicit XLSX cell cap as a precise partial export', async t => {
  t.mock.method(google, 'drive', () => ({
    files: { list: async () => ({ data: { files: [] } }) },
  }) as any);
  const sink = new GoogleWorkspaceExportSink();
  let destinationInput: any;
  t.mock.method(sink as any, 'createAndUploadXlsx', async (input: any) => {
    destinationInput = input;
    return {
      success: true as const,
      artifactId: 'xlsx-cell-cap',
      artifactUrl: 'https://drive.google.com/file/d/xlsx-cell-cap/view',
      artifactType: 'xlsx' as const,
      rowCount: input.rowCount,
      coverage: input.coverage,
      sourceTruncated: input.sourceTruncated,
      sharedWith: 'member@gmail.com (owner)',
      verified: true as const,
    };
  });

  const result = await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'xlsx-cell-cap',
    destination: {
      format: 'xlsx',
      title: 'Wide export',
      columns: Array.from({ length: 50 }, (_, index) => `column_${index}`),
    },
    rows: (async function* () {
      yield Array.from({ length: 2_001 }, (_, index) => ({ id: index + 1 }));
    })(),
    coverage: (rowsWritten) => ({
      inputRowsRead: 2_001,
      rowsWritten,
      outcome: 'complete',
    }),
    sourceTruncated: () => false,
  });

  assert.equal(destinationInput.rowCount, 1_999);
  assert.deepEqual(result.coverage, {
    inputRowsRead: 2_001,
    rowsWritten: 1_999,
    outcome: 'partial',
    cause: 'destination_cell_cap',
  });
  assert.equal(result.sourceTruncated, true);
});

it('expands Semrush trends into explicit CSV columns', async t => {
  let uploaded = '';
  const drive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async (input: any) => {
        assert.equal(input.requestBody.name, 'Semrush organic positions — example.com.csv');
        for await (const chunk of input.media.body) uploaded += String(chunk);
        return { data: { id: 'csv-1' } };
      },
      get: async () => ({
        data: {
          id: 'csv-1',
          size: String(Buffer.byteLength(uploaded)),
          webViewLink: 'https://drive.google.com/file/d/csv-1/view',
        },
      }),
      update: async () => ({ data: { id: 'csv-1' } }),
      delete: async () => assert.fail('successful export must not be deleted'),
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
  const result = await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'job-csv',
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'organic_positions', domain: 'example.com', database: 'in' },
    },
    destination: {
      format: 'csv',
      title: 'Semrush organic positions — example.com',
    },
    rows: (async function* () {
      yield [{
        Keyword: 'example keyword',
        Position: '6',
        Trends: '0.81,1.00,0.42',
        'SERP Features by Keyword': '1,7,9',
      }];
    })(),
    sourceTruncated: () => false,
  });

  assert.equal(result.artifactType, 'csv');
  const lines = uploaded.trim().split(/\r?\n/u);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], [
    'Keyword', 'Position',
    'Trend Period 01', 'Trend Period 02', 'Trend Period 03', 'Trend Period 04',
    'Trend Period 05', 'Trend Period 06', 'Trend Period 07', 'Trend Period 08',
    'Trend Period 09', 'Trend Period 10', 'Trend Period 11', 'Trend Period 12',
    'SERP Features by Keyword',
  ].join(','));
  assert.equal(lines[1], [
    'example keyword', '6', '0.81', '1', '0.42',
    '', '', '', '', '', '', '', '', '', '"1,7,9"',
  ].join(','));
  assert.doesNotMatch(lines[0] ?? '', /(^|,)Trends(,|$)/u);
});

it('does not fall back from an explicitly requested oversized XLSX export', async t => {
  t.mock.method(google, 'drive', () => ({
    files: { list: async () => ({ data: { files: [] } }) },
  }) as any);
  const sink = new GoogleWorkspaceExportSink();
  t.mock.method(sink as any, 'createAndUploadCsv', async () => {
    assert.fail('an explicit XLSX request must never fall back to CSV');
  });

  await assert.rejects(sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'oversized-xlsx',
    destination: { format: 'xlsx', title: 'Too many Excel rows' },
    rows: (async function* () {
      yield Array.from({ length: 5_001 }, (_, index) => ({ index }));
    })(),
    sourceTruncated: () => false,
  }), /Excel export exceeds the 5,000-row/);
});
