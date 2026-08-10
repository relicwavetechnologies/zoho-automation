import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { GoogleWorkspaceExportSink } from '../../src/application/data-export/google-workspace-export.sink.ts';

it('creates a typed Semrush sheet in the company account and grants only the invoker read access', async t => {
  const appendedValues: Array<{ range: string; values: unknown[][] }> = [];
  const overviewValues: unknown[][][] = [];
  const batchRequests: Record<string, unknown>[][] = [];
  const permissionCreates: unknown[] = [];
  const drive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      create: async (input: any) => {
        assert.equal(input.requestBody.name, 'Semrush organic positions — example.com');
        return { data: { id: 'sheet-1' } };
      },
      update: async () => ({ data: { id: 'sheet-1' } }),
      delete: async () => assert.fail('successful export must not be deleted'),
    },
    permissions: {
      list: async () => ({
        data: {
          permissions: [
            { type: 'user', role: 'owner', emailAddress: 'divo@emiactech.com' },
            ...(permissionCreates.length > 0
              ? [{ type: 'user', role: 'reader', emailAddress: 'member@emiactech.com' }]
              : []),
          ],
        },
      }),
      create: async (input: unknown) => { permissionCreates.push(input); return { data: { id: 'reader-1' } }; },
    },
  };
  const sheets = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [{ properties: { sheetId: 7, title: 'Sheet1', index: 0 } }],
        },
      }),
      batchUpdate: async (input: any) => {
        batchRequests.push(input.requestBody.requests);
        return batchRequests.length === 1
          ? {
              data: {
                replies: [
                  {},
                  { addSheet: { properties: { sheetId: 8 } } },
                  { addSheet: { properties: { sheetId: 9 } } },
                ],
              },
            }
          : { data: {} };
      },
      values: {
        append: async (input: any) => {
          appendedValues.push({ range: input.range, values: input.requestBody.values });
          return { data: {} };
        },
        update: async (input: any) => {
          overviewValues.push(input.requestBody.values);
          return { data: {} };
        },
        get: async (input: any) => {
          if (input.range === "'Trends'!1:1") {
            return {
              data: {
                values: [[
                  'Keyword', 'Url',
                  'Trend Period 01', 'Trend Period 02', 'Trend Period 03', 'Trend Period 04',
                  'Trend Period 05', 'Trend Period 06', 'Trend Period 07', 'Trend Period 08',
                  'Trend Period 09', 'Trend Period 10', 'Trend Period 11', 'Trend Period 12',
                ]],
              },
            };
          }
          assert.equal(input.range, "'Organic Positions'!1:1");
          return {
            data: {
              values: [[
                'Keyword', 'Position', 'Previous Position', 'Position Difference',
                'Search Volume', 'CPC', 'Url', 'Traffic (%)', 'Traffic Cost (%)',
                'Competition', 'Number of Results',
              ]],
            },
          };
        },
      },
    },
  };
  t.mock.method(google, 'drive', () => drive as any);
  t.mock.method(google, 'sheets', () => sheets as any);

  const sink = new GoogleWorkspaceExportSink();
  const result = await sink.write({
    auth: {
      accessToken: 'token',
      readerDomain: 'emiactech.com',
      companyOwnerEmail: 'divo@emiactech.com',
    },
    readerEmail: 'member@emiactech.com',
    exportKey: 'job-sheet',
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: {
        operation: 'domain_overview',
        domain: 'example.com',
        database: 'in',
      },
    },
    destination: {
      format: 'google_sheet',
      title: 'Semrush organic positions — example.com',
    },
    rows: (async function* () {
      yield [{
        Keyword: 'example keyword',
        Position: '6',
        'Previous Position': '9',
        'Position Difference': '3',
        'Search Volume': '1000',
        CPC: '0.73',
        Url: 'https://example.com/page',
        'Traffic (%)': '12.50',
        'Traffic Cost (%)': '1.25',
        Competition: '0.34',
        'Number of Results': '125000',
        Trends: '0.81,0.75,0.70',
      }];
    })(),
    coverage: (rowsWritten) => ({
      requestedRows: 1,
      inputRowsRead: rowsWritten,
      rowsWritten,
      outcome: 'requested_window_satisfied',
    }),
    sourceTruncated: () => false,
  });

  assert.equal(result.artifactType, 'google_sheet');
  assert.equal(result.rowCount, 1);
  assert.equal(result.coverage?.outcome, 'requested_window_satisfied');
  assert.equal(result.sharedWith, 'member@emiactech.com (reader)');
  assert.deepEqual(permissionCreates, [{
    fileId: 'sheet-1',
    requestBody: { type: 'user', role: 'reader', emailAddress: 'member@emiactech.com' },
    fields: 'id',
    sendNotificationEmail: false,
  }]);
  assert.deepEqual(appendedValues[0], {
    range: 'Sheet1!A1',
    values: [
    [
      'Keyword', 'Position', 'Previous Position', 'Position Difference',
      'Search Volume', 'CPC', 'Url', 'Traffic (%)', 'Traffic Cost (%)',
      'Competition', 'Number of Results',
    ],
    [
      'example keyword', 6, 9, 3, 1000, 0.73, 'https://example.com/page',
      12.5, 1.25, 0.34, 125000,
    ],
  ] });
  assert.deepEqual(appendedValues[1], {
    range: "'Trends'!A1",
    values: [
      [
        'Keyword', 'Url',
        'Trend Period 01', 'Trend Period 02', 'Trend Period 03', 'Trend Period 04',
        'Trend Period 05', 'Trend Period 06', 'Trend Period 07', 'Trend Period 08',
        'Trend Period 09', 'Trend Period 10', 'Trend Period 11', 'Trend Period 12',
      ],
      [
        'example keyword', 'https://example.com/page', 0.81, 0.75, 0.7,
        '', '', '', '', '', '', '', '', '',
      ],
    ],
  });
  assert.equal(overviewValues.length, 1);
  assert.deepEqual(overviewValues[0]?.slice(0, 8).map(row => row[0]), [
    'Semrush organic positions — example.com',
    'Source',
    'Report',
    'Subject',
    'Database',
    'Retrieved at',
    'Rows exported',
    'Completeness',
  ]);
  assert.equal(overviewValues[0]?.find(row => row[0] === 'Subject')?.[1], 'example.com');
  assert.equal(overviewValues[0]?.find(row => row[0] === 'Rows exported')?.[1], 1);
  assert.equal(overviewValues[0]?.find(row => row[0] === 'Completeness')?.[1], 'Requested row window satisfied');
  assert.match(String(overviewValues[0]?.find(row => row[0] === 'Metric note')?.[1]), /currency-neutral/i);
  assert.match(String(overviewValues[0]?.find(row => row[0] === 'Trend note')?.[1]), /provider order/i);
  assert.doesNotMatch(JSON.stringify(overviewValues), /[$₹€£]/);

  const allFormattingRequests = batchRequests.flat();
  assert.ok(allFormattingRequests.some(request => 'setBasicFilter' in request));
  assert.ok(allFormattingRequests.some(request =>
    JSON.stringify(request).includes('Organic Positions')
    && JSON.stringify(request).includes('frozenRowCount')));
  const numberPatterns = allFormattingRequests.flatMap((request: any) => {
    const pattern = request.repeatCell?.cell?.userEnteredFormat?.numberFormat?.pattern;
    return pattern ? [pattern] : [];
  });
  assert.ok(numberPatterns.includes('#,##0'));
  assert.ok(numberPatterns.includes('0.00'));
  assert.ok(numberPatterns.includes('0.00"%"'));
});

it('writes an existing editable Sheet only through one verified new tab', async t => {
  const appended: Array<{ range: string; values: unknown[][] }> = [];
  const batchRequests: Record<string, unknown>[][] = [];
  let tabTitle = '';
  let tabCreated = false;
  let failFormatting = true;
  const drive = {
    files: {
      get: async (input: any) => {
        assert.equal(input.fileId, 'existing_sheet');
        return {
          data: {
            id: 'existing_sheet',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            trashed: false,
            capabilities: { canEdit: true },
          },
        };
      },
      list: async () => assert.fail('existing Sheet writes must not run artifact recovery'),
      create: async () => assert.fail('existing Sheet writes must not create a Drive file'),
      update: async () => assert.fail('existing Sheet writes must not mutate Drive metadata'),
      delete: async () => assert.fail('existing Sheet writes must never delete the workbook'),
    },
    permissions: {
      list: async () => assert.fail('existing Sheet writes must not inspect or alter sharing'),
      create: async () => assert.fail('existing Sheet writes must not alter sharing'),
    },
  };
  const sheets = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [
            { properties: { sheetId: 1, title: 'User data' } },
            ...(tabCreated ? [{ properties: { sheetId: 27, title: tabTitle } }] : []),
          ],
        },
      }),
      batchUpdate: async (input: any) => {
        batchRequests.push(input.requestBody.requests);
        if ('addSheet' in input.requestBody.requests[0]) {
          tabTitle = input.requestBody.requests[0].addSheet.properties.title;
          tabCreated = true;
          return { data: { replies: [{ addSheet: { properties: { sheetId: 27 } } }] } };
        }
        if (failFormatting) {
          failFormatting = false;
          throw new Error('temporary formatting failure');
        }
        return { data: {} };
      },
      values: {
        append: async (input: any) => {
          appended.push({ range: input.range, values: input.requestBody.values });
          return { data: { updates: { updatedRows: input.requestBody.values.length } } };
        },
        get: async (input: any) => {
          if (!input.range.includes('!')) return { data: { values: appended[0]?.values ?? [] } };
          if (input.range.endsWith('!1:1')) return { data: { values: [['Name', 'Count']] } };
          assert.ok(input.range.endsWith('!3:3'));
          return { data: { values: [['Two', 2]] } };
        },
      },
    },
  };
  t.mock.method(google, 'drive', () => drive as any);
  t.mock.method(google, 'sheets', () => sheets as any);

  const write = () => new GoogleWorkspaceExportSink().write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'existing-sheet-job',
    destination: {
      format: 'google_sheet',
      title: 'Customer counts',
      target: {
        kind: 'existing_google_sheet',
        connectionId: '11111111-1111-4111-8111-111111111111',
        spreadsheetId: 'existing_sheet',
        gid: '1',
        mode: 'new_tab',
      },
    },
    rows: (async function* () {
      yield [{ Name: 'One', Count: 1 }, { Name: 'Two', Count: 2 }];
    })(),
    sourceTruncated: () => false,
  });
  await assert.rejects(write(), /temporary formatting failure/);
  const result = await write();

  assert.match(tabTitle, /^Customer counts · [0-9a-f]{16}$/);
  assert.ok(tabTitle.length <= 100);
  assert.deepEqual(appended, [{
    range: `'${tabTitle}'!A1`,
    values: [['Name', 'Count'], ['One', 1], ['Two', 2]],
  }]);
  assert.equal(batchRequests.length, 3);
  assert.ok(batchRequests[2]?.some(request => 'setBasicFilter' in request));
  assert.equal(result.artifactId, 'existing_sheet');
  assert.equal(result.artifactUrl, 'https://docs.google.com/spreadsheets/d/existing_sheet/edit#gid=27');
  assert.equal(result.rowCount, 2);
  assert.equal(result.verified, true);
});

it('resumes a partially written Divo tab without creating another tab', async t => {
  let tabTitle = '';
  let tabCreated = false;
  let addSheetCalls = 0;
  let appendCalls = 0;
  let failNextBatch = true;
  const storedValues: unknown[][] = [];
  t.mock.method(google, 'drive', () => ({
    files: {
      get: async () => ({
        data: {
          id: 'existing_sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          trashed: false,
          capabilities: { canEdit: true },
        },
      }),
    },
  }) as any);
  t.mock.method(google, 'sheets', () => ({
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: tabCreated ? [{ properties: { sheetId: 27, title: tabTitle } }] : [],
        },
      }),
      batchUpdate: async (input: any) => {
        if ('addSheet' in input.requestBody.requests[0]) {
          addSheetCalls += 1;
          tabTitle = input.requestBody.requests[0].addSheet.properties.title;
          tabCreated = true;
          return { data: { replies: [{ addSheet: { properties: { sheetId: 27 } } }] } };
        }
        return { data: {} };
      },
      values: {
        append: async (input: any) => {
          appendCalls += 1;
          if (appendCalls === 2 && failNextBatch) {
            failNextBatch = false;
            throw new Error('temporary append failure');
          }
          storedValues.push(...input.requestBody.values);
          return { data: {} };
        },
        get: async (input: any) => {
          if (!input.range.includes('!')) return { data: { values: storedValues } };
          if (input.range.endsWith('!1:1')) return { data: { values: [storedValues[0]] } };
          return { data: { values: [storedValues.at(-1)] } };
        },
      },
    },
  }) as any);

  const write = () => new GoogleWorkspaceExportSink().write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'partial-existing-sheet-job',
    destination: {
      format: 'google_sheet',
      title: 'Resumable rows',
      target: {
        kind: 'existing_google_sheet',
        connectionId: '11111111-1111-4111-8111-111111111111',
        spreadsheetId: 'existing_sheet',
        mode: 'new_tab',
      },
    },
    rows: (async function* () {
      yield Array.from({ length: 501 }, (_, index) => ({ Index: index + 1 }));
    })(),
    sourceTruncated: () => false,
  });

  await assert.rejects(write(), /temporary append failure/);
  const recovered = await write();
  assert.equal(addSheetCalls, 1);
  assert.equal(storedValues.length, 502);
  assert.deepEqual(storedValues.at(-1), [501]);
  assert.equal(recovered.rowCount, 501);
  assert.equal(recovered.verified, true);
});

it('rejects an oversized existing-Sheet export before touching the workbook', async t => {
  t.mock.method(google, 'drive', () => assert.fail('oversized data must fail before Drive access') as any);
  t.mock.method(google, 'sheets', () => assert.fail('oversized data must fail before Sheets access') as any);

  await assert.rejects(
    new GoogleWorkspaceExportSink().write({
      auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
      readerEmail: 'member@gmail.com',
      exportKey: 'oversized-existing-sheet-job',
      destination: {
        format: 'google_sheet',
        title: 'Too many rows',
        target: {
          kind: 'existing_google_sheet',
          connectionId: '11111111-1111-4111-8111-111111111111',
          spreadsheetId: 'existing_sheet',
          mode: 'new_tab',
        },
      },
      rows: (async function* () {
        for (let index = 0; index < 50_001; index += 1) yield [{ index }];
      })(),
      sourceTruncated: () => false,
    }),
    /Dataset is too large for the requested Google Sheet/,
  );
});

it('selects Sheet or CSV for auto only after the final row and cell counts are known', async t => {
  t.mock.method(google, 'drive', () => ({
    files: { list: async () => ({ data: { files: [] } }) },
  }) as any);
  const selected: string[] = [];
  const sink = new GoogleWorkspaceExportSink();
  t.mock.method(sink as any, 'createSheet', async (input: any) => {
    selected.push(`sheet:${input.rowCount}`);
    return completion('google_sheet', input.rowCount, input.sourceTruncated);
  });
  t.mock.method(sink as any, 'createAndUploadCsv', async (input: any) => {
    selected.push(`csv:${input.rowCount}`);
    return completion('csv', input.rowCount, input.sourceTruncated);
  });

  const rows = Array.from({ length: 5_001 }, (_, index) => ({ id: index + 1 }));
  await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'auto-sheet',
    destination: { format: 'auto', title: 'Eligible', columns: ['id'] },
    rows: (async function* () { yield rows; })(),
    sourceTruncated: () => false,
  });
  await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'auto-csv',
    destination: {
      format: 'auto',
      title: 'Too many cells',
      columns: Array.from({ length: 400 }, (_, index) => `column_${index}`),
    },
    rows: (async function* () { yield rows; })(),
    sourceTruncated: () => false,
  });
  await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'auto-csv-row-limit',
    destination: { format: 'auto', title: 'Too many Sheet rows', columns: ['id'] },
    rows: (async function* () {
      for (let offset = 0; offset < 50_001; offset += 1_000) {
        const count = Math.min(1_000, 50_001 - offset);
        yield Array.from({ length: count }, (_, index) => ({ id: offset + index + 1 }));
      }
    })(),
    sourceTruncated: () => false,
  });

  assert.deepEqual(selected, ['sheet:5001', 'csv:5001', 'csv:50001']);
});

it('counts Semrush Trends and Overview cells for auto selection and Sheet clipping', async t => {
  t.mock.method(google, 'drive', () => ({
    files: { list: async () => ({ data: { files: [] } }) },
  }) as any);
  const selected: string[] = [];
  const sink = new GoogleWorkspaceExportSink();
  t.mock.method(sink as any, 'createSheet', async (input: any) => {
    selected.push(`sheet:${input.rowCount}`);
    return completion('google_sheet', input.rowCount, input.sourceTruncated);
  });
  t.mock.method(sink as any, 'createAndUploadCsv', async (input: any) => {
    selected.push(`csv:${input.rowCount}`);
    return completion('csv', input.rowCount, input.sourceTruncated);
  });

  const columns = Array.from({ length: 99 }, (_, index) => index === 0
    ? 'Keyword'
    : index === 1
      ? 'Url'
      : index === 2
        ? 'Trends'
        : `column_${index}`);
  const rows = Array.from({ length: 17_858 }, (_, index) => ({ id: index + 1 }));
  const source = {
    kind: 'semrush_snapshot' as const,
    connectionId: 'backend_managed' as const,
    args: {
      operation: 'domain_overview' as const,
      domain: 'example.com',
      database: 'in' as const,
    },
  };

  await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'auto-semrush-footprint',
    source,
    destination: { format: 'auto', title: 'Semrush footprint', columns },
    rows: (async function* () { yield rows; })(),
    sourceTruncated: () => false,
  });
  await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'sheet-semrush-footprint',
    source,
    destination: { format: 'google_sheet', title: 'Semrush footprint', columns },
    rows: (async function* () { yield rows; })(),
    sourceTruncated: () => false,
  });

  assert.deepEqual(selected, ['csv:17858', 'sheet:17855']);
});

it('delivers an explicit Sheet cell cap as a precise partial export', async t => {
  t.mock.method(google, 'drive', () => ({
    files: { list: async () => ({ data: { files: [] } }) },
  }) as any);
  const sink = new GoogleWorkspaceExportSink();
  let destinationInput: any;
  t.mock.method(sink as any, 'createSheet', async (input: any) => {
    destinationInput = input;
    return {
      ...completion('google_sheet', input.rowCount, input.sourceTruncated),
      coverage: input.coverage,
    };
  });

  const result = await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'sheet-cell-cap',
    destination: {
      format: 'google_sheet',
      title: 'Wide export',
      columns: Array.from({ length: 50 }, (_, index) => `column_${index}`),
    },
    rows: (async function* () {
      for (let offset = 0; offset < 40_001; offset += 1_000) {
        const count = Math.min(1_000, 40_001 - offset);
        yield Array.from({ length: count }, (_, index) => ({ id: offset + index + 1 }));
      }
    })(),
    coverage: (rowsWritten) => ({
      inputRowsRead: 40_001,
      rowsWritten,
      outcome: 'complete',
    }),
    sourceTruncated: () => false,
  });

  assert.equal(destinationInput.rowCount, 39_999);
  assert.deepEqual(result.coverage, {
    inputRowsRead: 40_001,
    rowsWritten: 39_999,
    outcome: 'partial',
    cause: 'destination_cell_cap',
  });
  assert.ok((destinationInput.rowCount + 1) * 50 <= 2_000_000);
  assert.equal(result.sourceTruncated, true);
});

it('truncates a Menhood spool at its byte boundary and closes the source iterator', async t => {
  t.mock.method(google, 'drive', () => ({
    files: { list: async () => ({ data: { files: [] } }) },
  }) as any);
  const temporaryDirectoryRoot = await mkdtemp(join(tmpdir(), 'divo-export-test-'));
  t.after(() => rm(temporaryDirectoryRoot, { recursive: true, force: true }));
  let iteratorClosed = false;
  const sink = new GoogleWorkspaceExportSink({
    menhoodSpoolByteLimit: 32,
    temporaryDirectoryRoot,
  });
  t.mock.method(sink as any, 'createAndUploadCsv', async (input: any) => {
    assert.equal(input.rowCount, 1);
    assert.equal(input.sourceTruncated, true);
    return { ...completion('csv', input.rowCount, input.sourceTruncated), coverage: input.coverage };
  });

  const result = await sink.write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'menhood-byte-limit',
    source: {
      kind: 'menhood_query',
      connectionId: 'backend_managed',
      query: { sql: 'SELECT * FROM menhood_orders' },
      queryFingerprint: 'a'.repeat(64),
    },
    destination: { format: 'csv', title: 'Menhood orders' },
    rows: (async function* () {
      try {
        yield [{ value: 'ok' }, { value: 'x'.repeat(100) }];
      } finally {
        iteratorClosed = true;
      }
    })(),
    coverage: (rowsWritten) => ({
      inputRowsRead: 2,
      rowsWritten,
      outcome: 'complete',
    }),
    sourceTruncated: () => false,
  });

  assert.equal(result.rowCount, 1);
  assert.equal(result.sourceTruncated, true);
  assert.deepEqual(result.coverage, {
    inputRowsRead: 2,
    rowsWritten: 1,
    outcome: 'partial',
    cause: 'spool_cap',
  });
  assert.equal(iteratorClosed, true);
  assert.deepEqual(await readdir(temporaryDirectoryRoot), []);
});

it('closes the source and removes its spool when cancellation interrupts reading', async t => {
  t.mock.method(google, 'drive', () => ({
    files: { list: async () => ({ data: { files: [] } }) },
  }) as any);
  const temporaryDirectoryRoot = await mkdtemp(join(tmpdir(), 'divo-export-cancel-test-'));
  t.after(() => rm(temporaryDirectoryRoot, { recursive: true, force: true }));
  const controller = new AbortController();
  let iteratorClosed = false;

  await assert.rejects(new GoogleWorkspaceExportSink({ temporaryDirectoryRoot }).write({
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'cancelled-spool',
    destination: { format: 'csv', title: 'Cancelled' },
    rows: (async function* () {
      try {
        yield [{ value: 'written' }];
        controller.abort();
        yield [{ value: 'must not be written' }];
      } finally {
        iteratorClosed = true;
      }
    })(),
    sourceTruncated: () => false,
    signal: controller.signal,
  }), error => error instanceof Error && error.name === 'AbortError');

  assert.equal(iteratorClosed, true);
  assert.deepEqual(await readdir(temporaryDirectoryRoot), []);
});

function completion(
  artifactType: 'google_sheet' | 'csv',
  rowCount: number,
  sourceTruncated: boolean,
) {
  return {
    success: true as const,
    artifactId: `artifact-${artifactType}`,
    artifactUrl: `https://example.com/${artifactType}`,
    artifactType,
    rowCount,
    sourceTruncated,
    sharedWith: 'member@gmail.com (owner)',
    verified: true as const,
  };
}
