import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataExportPresentation } from '../../src/application/data-export/data-export-presentation.ts';

describe('buildDataExportPresentation', () => {
  it('splits keyword research trends and titles the sheet for that operation', () => {
    const presentation = buildDataExportPresentation({
      title: 'Semrush keyword research',
      columns: ['Keyword', 'Search Volume', 'CPC', 'Competition', 'Number of Results', 'Trends'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'keyword_research', keywords: ['alpha', 'beta'], database: 'in' },
      },
      rowCount: 1,
      sourceTruncated: false,
    });

    assert.equal(presentation.dataSheetTitle, 'Keyword Research');
    assert.deepEqual(presentation.mainColumns, [
      'Keyword', 'Search Volume', 'CPC', 'Competition', 'Number of Results',
    ]);
    assert.equal(presentation.flatColumns.includes('Trend Period 01'), true);
    assert.equal(presentation.flatColumns.includes('Trends'), false);
    assert.deepEqual(presentation.trends?.columns.slice(0, 2), ['Keyword', 'Trend Period 01']);
    assert.deepEqual(presentation.trendRow({
      Keyword: 'alpha',
      Trends: '0.50,1.00',
    }), ['alpha', 0.5, 1, '', '', '', '', '', '', '', '', '', '']);
    const overview = Object.fromEntries(
      (presentation.overviewRows ?? []).map(row => [row[0], row[1]]),
    );
    assert.match(String(overview['Keyword note']), /1 of 2 requested keyword/);
    assert.equal(overview['Gap note'], undefined);
    assert.match(String(overview['Trend note']), /Trend Period 01/);
  });

  it('types gap position columns and keeps organic positions behavior unchanged', () => {
    const presentation = buildDataExportPresentation({
      title: 'Semrush keyword gap',
      columns: ['Keyword', 'Search Volume', 'CPC', 'Competition', 'competitor.com', 'mine.com'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'keyword_gap', targets: ['mine.com', 'competitor.com'], database: 'in', limit: 5 },
      },
      rowCount: 1,
      sourceTruncated: false,
    });

    assert.equal(presentation.dataSheetTitle, 'Keyword Gap');
    assert.deepEqual(presentation.mainRow({
      Keyword: 'atm',
      'Search Volume': '673000',
      CPC: '0.27',
      Competition: '0.12',
      'competitor.com': '3',
      'mine.com': '-',
    }), ['atm', 673000, 0.27, 0.12, 3, '']);
    const overview = Object.fromEntries(
      (presentation.overviewRows ?? []).map(row => [row[0], row[1]]),
    );
    assert.match(String(overview['Gap note']), /first target \(mine\.com\) is excluded/);
    assert.equal(overview['Trend note'], undefined);
  });

  it('formats backlinks metrics and history dates', () => {
    const backlinks = buildDataExportPresentation({
      title: 'Semrush backlinks',
      columns: ['target', 'ascore', 'total', 'domains_num'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] },
      },
      rowCount: 2,
      sourceTruncated: false,
    });
    assert.equal(backlinks.dataSheetTitle, 'Backlinks Comparison');
    assert.deepEqual(backlinks.mainRow({
      target: 'a.com',
      ascore: '73',
      total: '1200',
      domains_num: '126236',
    }), ['a.com', 73, 1200, 126236]);
    const overview = Object.fromEntries(
      (backlinks.overviewRows ?? []).map(row => [row[0], row[1]]),
    );
    assert.match(String(overview['Billing note']), /one backlinks_overview request per target/);

    const trend = buildDataExportPresentation({
      title: 'Semrush trend',
      columns: ['Date', 'Rank', 'Organic Keywords'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'organic_position_trend', domain: 'example.com', database: 'in' },
      },
      rowCount: 1,
      sourceTruncated: false,
    });
    assert.equal(trend.dataSheetTitle, 'Position Trend');
    assert.deepEqual(trend.mainRow({
      Date: '20260615',
      Rank: '288510',
      'Organic Keywords': '46',
    }), ['2026-06-15', 288510, 46]);
    const trendOverview = Object.fromEntries(
      (trend.overviewRows ?? []).map(row => [row[0], row[1]]),
    );
    assert.match(String(trendOverview['History note']), /domain_rank_history/);
    assert.equal(trendOverview['Trend note'], undefined);
  });

  it('still treats missing organic position values as blank cells', () => {
    const presentation = buildDataExportPresentation({
      title: 'Semrush organic positions',
      columns: ['Keyword', 'Position', 'Trends', 'Url'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'organic_positions', domain: 'example.com', database: 'in', limit: 50 },
      },
      rowCount: 1,
      sourceTruncated: false,
    });

    assert.equal(presentation.dataSheetTitle, 'Organic Positions');
    assert.equal(presentation.mainRow({ Keyword: 'x', Position: '-', Url: 'https://example.com', Trends: '1.00' })[1], '');
    assert.deepEqual(presentation.trends?.columns.slice(0, 2), ['Keyword', 'Url']);
  });
});
