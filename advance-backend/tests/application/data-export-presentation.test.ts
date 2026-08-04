import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataExportPresentation } from '../../src/application/data-export/data-export-presentation.ts';

describe('buildDataExportPresentation', () => {
  it('formats domain overview metrics', () => {
    const presentation = buildDataExportPresentation({
      title: 'Semrush domain overview',
      columns: ['Domain', 'Rank', 'Organic Keywords'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'domain_overview', domain: 'example.com', database: 'in' },
      },
      rowCount: 1,
      sourceTruncated: false,
    });

    assert.equal(presentation.dataSheetTitle, 'Domain Overview');
    assert.deepEqual(presentation.mainRow({
      Domain: 'example.com',
      Rank: '288510',
      'Organic Keywords': '46',
    }), ['example.com', 288510, 46]);
    const overview = Object.fromEntries(
      (presentation.overviewRows ?? []).map(row => [row[0], row[1]]),
    );
    assert.equal(overview['Source'], 'Semrush web');
  });

  it('formats backlinks metrics and billing note', () => {
    const presentation = buildDataExportPresentation({
      title: 'Semrush backlinks',
      columns: ['Target', 'Authority Score', 'Backlinks'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] },
      },
      rowCount: 2,
      sourceTruncated: false,
    });

    assert.equal(presentation.dataSheetTitle, 'Backlinks Comparison');
    assert.deepEqual(presentation.mainRow({
      Target: 'a.com',
      'Authority Score': '73',
      Backlinks: '1200',
    }), ['a.com', 73, 1200]);
    const overview = Object.fromEntries(
      (presentation.overviewRows ?? []).map(row => [row[0], row[1]]),
    );
    assert.match(String(overview['Billing note']), /one Semrush web request covers all targets/i);
  });

  it('formats keyword position trend dates and scope note', () => {
    const presentation = buildDataExportPresentation({
      title: 'Semrush keyword trend',
      columns: ['Date', 'Position', 'Keyword'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: {
          operation: 'keyword_position_trend',
          domain: 'example.com',
          keyword: 'payments',
          date: '20260719',
          database: 'in',
        },
      },
      rowCount: 1,
      sourceTruncated: false,
    });

    assert.equal(presentation.dataSheetTitle, 'Keyword Position Trend');
    assert.deepEqual(presentation.mainRow({
      Date: '20260719',
      Position: '3',
      Keyword: 'payments',
    }), ['2026-07-19', 3, 'payments']);
    const overview = Object.fromEntries(
      (presentation.overviewRows ?? []).map(row => [row[0], row[1]]),
    );
    assert.match(String(overview['Scope note']), /payments/);
  });
});
