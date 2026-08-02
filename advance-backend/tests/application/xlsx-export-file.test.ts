import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import {
  XLSX_MAX_CELLS,
  writeXlsxArtifact,
} from '../../src/application/data-export/xlsx-export-file.ts';

describe('writeXlsxArtifact', () => {
  it('writes and reopens a structurally verified Excel workbook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'divo-xlsx-test-'));
    const path = join(directory, 'export.xlsx');
    const progress: number[] = [];
    try {
      await writeXlsxArtifact({
        path,
        columns: ['Name', 'Amount', 'Formula', 'Metadata', 'Record ID'],
        rows: rows([
          { Name: 'Alpha', Amount: 25, Formula: '=1+1', Metadata: { active: true }, 'Record ID': '1000000000000000001' },
          { Name: 'Beta', Amount: 40, Formula: '@SUM(A1)', Metadata: null, 'Record ID': '1000000000000000002' },
        ]),
        rowCount: 2,
        onProgress: async update => {
          progress.push(update.rowsProcessed);
        },
      });

      const workbook = XLSX.readFile(path, { cellStyles: true });
      const sheet = workbook.Sheets['Export'];
      assert.ok(sheet);
      assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }), [
        ['Name', 'Amount', 'Formula', 'Metadata', 'Record ID'],
        ['Alpha', 25, "'=1+1", '{"active":true}', '1000000000000000001'],
        ['Beta', 40, "'@SUM(A1)", '', '1000000000000000002'],
      ]);
      assert.equal(sheet['!autofilter']?.ref, 'A1:E3');
      assert.equal(sheet['!cols']?.length, 5);
      assert.ok((sheet['!cols']?.[4]?.width ?? 0) >= 21);
      assert.equal(sheet.E2?.t, 's');
      assert.deepEqual(progress, [2]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a workbook above the bounded in-memory cell ceiling before reading rows', async () => {
    let rowsRead = 0;
    await assert.rejects(writeXlsxArtifact({
      path: '/unused/export.xlsx',
      columns: Array.from({ length: 101 }, (_, index) => `c${index}`),
      rows: (async function* () {
        rowsRead += 1;
        yield {};
      })(),
      rowCount: Math.floor(XLSX_MAX_CELLS / 101) + 1,
    }), /cell safety ceiling/i);
    assert.equal(rowsRead, 0);
  });

  it('separates Semrush trend values into a typed worksheet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'divo-xlsx-semrush-test-'));
    const path = join(directory, 'organic.xlsx');
    try {
      await writeXlsxArtifact({
        path,
        title: 'Semrush organic positions — example.com',
        source: {
          kind: 'semrush_snapshot',
          connectionId: 'backend_managed',
          args: { operation: 'organic_positions', domain: 'example.com', database: 'in' },
        },
        columns: [
          'Keyword', 'Position', 'Search Volume', 'Url', 'Trends',
          'SERP Features by Keyword', 'SERP Features by Position',
        ],
        rows: rows([{
          Keyword: 'example keyword',
          Position: '6',
          'Search Volume': '1000',
          Url: 'https://example.com/page',
          Trends: '0.81,1.00,0.42',
          'SERP Features by Keyword': '1,7,9',
          'SERP Features by Position': '',
        }]),
        rowCount: 1,
      });

      const workbook = XLSX.readFile(path, { cellStyles: true });
      assert.deepEqual(workbook.SheetNames, ['Overview', 'Organic Positions', 'Trends']);
      const positions = workbook.Sheets['Organic Positions'];
      const trends = workbook.Sheets.Trends;
      assert.ok(positions);
      assert.ok(trends);
      assert.deepEqual(XLSX.utils.sheet_to_json(positions, { header: 1, raw: true, defval: '' }), [
        [
          'Keyword', 'Position', 'Search Volume', 'Url',
          'SERP Features by Keyword', 'SERP Features by Position',
        ],
        ['example keyword', 6, 1000, 'https://example.com/page', '1,7,9', ''],
      ]);
      const trendRows = XLSX.utils.sheet_to_json<unknown[]>(trends, {
        header: 1,
        raw: true,
        defval: '',
      });
      assert.deepEqual(trendRows[0], [
        'Keyword', 'Url',
        'Trend Period 01', 'Trend Period 02', 'Trend Period 03', 'Trend Period 04',
        'Trend Period 05', 'Trend Period 06', 'Trend Period 07', 'Trend Period 08',
        'Trend Period 09', 'Trend Period 10', 'Trend Period 11', 'Trend Period 12',
      ]);
      assert.deepEqual(trendRows[1], [
        'example keyword', 'https://example.com/page', 0.81, 1, 0.42,
        '', '', '', '', '', '', '', '', '',
      ]);
      assert.equal(positions.B2?.t, 'n');
      assert.equal(positions.B2?.z, '#,##0');
      assert.equal(trends.C2?.z, '0.00');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function* rows(
  values: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  for (const value of values) yield value;
}
