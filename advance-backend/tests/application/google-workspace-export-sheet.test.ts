import { it } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { GoogleWorkspaceExportSink } from '../../src/application/data-export/google-workspace-export.sink.ts';

it('creates a typed and presentation-ready Semrush organic positions sheet', async t => {
  const appendedValues: unknown[][][] = [];
  const overviewValues: unknown[][][] = [];
  const batchRequests: Record<string, unknown>[][] = [];
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
            { type: 'user', role: 'owner', emailAddress: 'member@gmail.com' },
          ],
        },
      }),
      create: async () => assert.fail('owner export must not create a reader permission'),
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
          ? { data: { replies: [{}, { addSheet: { properties: { sheetId: 8 } } }] } }
          : { data: {} };
      },
      values: {
        append: async (input: any) => {
          appendedValues.push(input.requestBody.values);
          return { data: {} };
        },
        update: async (input: any) => {
          overviewValues.push(input.requestBody.values);
          return { data: {} };
        },
        get: async (input: any) => {
          assert.equal(input.range, "'Organic Positions'!1:1");
          return {
            data: {
              values: [[
                'Keyword', 'Position', 'Previous Position', 'Position Difference',
                'Search Volume', 'CPC', 'Url', 'Traffic (%)', 'Traffic Cost (%)',
                'Competition', 'Number of Results', 'Trends',
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
    auth: { accessToken: 'token', ownerEmail: 'member@gmail.com' },
    readerEmail: 'member@gmail.com',
    exportKey: 'job-sheet',
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: {
        operation: 'organic_positions',
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
    sourceTruncated: () => false,
  });

  assert.equal(result.artifactType, 'google_sheet');
  assert.equal(result.rowCount, 1);
  assert.deepEqual(appendedValues, [[
    [
      'Keyword', 'Position', 'Previous Position', 'Position Difference',
      'Search Volume', 'CPC', 'Url', 'Traffic (%)', 'Traffic Cost (%)',
      'Competition', 'Number of Results', 'Trends',
    ],
    [
      'example keyword', 6, 9, 3, 1000, 0.73, 'https://example.com/page',
      12.5, 1.25, 0.34, 125000, '0.81,0.75,0.70',
    ],
  ]]);
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
  assert.match(String(overviewValues[0]?.find(row => row[0] === 'Metric note')?.[1]), /currency-neutral/i);
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
