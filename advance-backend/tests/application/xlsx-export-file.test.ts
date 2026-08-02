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
        columns: ['Name', 'Amount', 'Formula', 'Metadata'],
        rows: rows([
          { Name: 'Alpha', Amount: 25, Formula: '=1+1', Metadata: { active: true } },
          { Name: 'Beta', Amount: 40, Formula: '@SUM(A1)', Metadata: null },
        ]),
        rowCount: 2,
        onProgress: async update => {
          progress.push(update.rowsProcessed);
        },
      });

      const workbook = XLSX.readFile(path);
      const sheet = workbook.Sheets['Export'];
      assert.ok(sheet);
      assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' }), [
        ['Name', 'Amount', 'Formula', 'Metadata'],
        ['Alpha', 25, "'=1+1", '{"active":true}'],
        ['Beta', 40, "'@SUM(A1)", ''],
      ]);
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
});

async function* rows(
  values: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  for (const value of values) yield value;
}
