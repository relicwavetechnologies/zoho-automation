import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataExportPresentation } from '../../src/application/data-export/data-export-presentation.ts';

describe('buildDataExportPresentation semrush overview sheet', () => {
  const overviewFor = (args: Record<string, unknown>, rowCount: number) => {
    const rows = buildDataExportPresentation({
      title: 'Semrush country traffic emiactech',
      columns: ['Database', 'Domain', 'Rank'],
      source: { kind: 'semrush_snapshot', connectionId: 'backend_managed', args } as never,
      rowCount,
      sourceTruncated: false,
    }).overviewRows ?? [];
    return new Map(rows.filter(row => row.length > 1).map(row => [String(row[0]), String(row[1])]));
  };

  it('does not describe a 26-country file as one country', () => {
    // The file carries every country database Semrush holds. Naming only the
    // requested one read as "this is Indian data", which the rows contradict.
    const overview = overviewFor({ operation: 'domain_overview', domain: 'emiactech.com', database: 'in' }, 26);
    assert.notEqual(overview.get('Database'), 'in');
    assert.match(overview.get('Database')!, /^in first, then every other country/);
    assert.equal(overview.get('Rows exported'), '26');
    assert.match(overview.get('Scope note')!, /One row per country database/);
    // Absent is not zero — the same distinction backlinks already makes.
    assert.match(overview.get('Scope note')!, /not the same as zero traffic/);
  });

  it('still names the single database an operation is genuinely scoped to', () => {
    const overview = overviewFor(
      { operation: 'keyword_position_trend', domain: 'decentro.tech', keyword: 'upi payment gateway', date: '20260719', database: 'in' },
      28,
    );
    assert.equal(overview.get('Database'), 'in');
  });

  it('says database is not applicable where the operation has none', () => {
    const overview = overviewFor({ operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] }, 2);
    assert.equal(overview.get('Database'), 'Not applicable');
  });

  it('defines every derived column in the file that carries them', () => {
    // A number a reader cannot reproduce is one they either over-trust or
    // ignore. The file outlives the chat, so the arithmetic ships with it.
    const rows = buildDataExportPresentation({
      title: 'Semrush country traffic emiactech',
      columns: [
        'Database', 'Organic Traffic', 'Traffic Rank', 'Traffic Share %',
        'Cumulative Traffic %', 'Traffic per Keyword', 'Value per Visit', 'Market Tier',
      ],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'domain_overview', domain: 'emiactech.com', database: 'in' },
      } as never,
      rowCount: 26,
      sourceTruncated: false,
    }).overviewRows ?? [];
    const overview = new Map(rows.filter(row => row.length > 1).map(row => [String(row[0]), String(row[1])]));

    for (const column of [
      'Traffic Rank', 'Traffic Share %', 'Cumulative Traffic %',
      'Traffic per Keyword', 'Value per Visit', 'Market Tier',
    ]) {
      assert.ok(overview.has(column), `${column} must be defined in the summary sheet`);
    }
    assert.match(overview.get('Derived columns')!, /No extra Semrush request was made/);
    assert.match(overview.get('Market Tier')!, /Dormant = Semrush measured exactly zero traffic/);
    // The distinction the whole report rests on, restated where a reader lands.
    assert.match(overview.get('Dormant vs absent')!, /never measured, and is not dormant/);
  });

  it('says Authority Rank is per tab, because a split comparison restarts it', () => {
    // Eleven targets need two Semrush requests, so the overflow tab holds one
    // row and ranks it 1 — reading as the strongest site when it was eighth.
    const rows = buildDataExportPresentation({
      title: 'Semrush Backlinks Comparison - 11 Sites',
      columns: ['Target', 'Authority Score', 'Authority Rank', 'Backlinks per Referring Domain'],
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'backlinks_comparison', targets: ['a.com'] },
      } as never,
      rowCount: 1,
      sourceTruncated: false,
    }).overviewRows ?? [];
    const overview = new Map(rows.filter(row => row.length > 1).map(row => [String(row[0]), String(row[1])]));

    assert.match(overview.get('Authority Rank')!, /within this tab only/);
    assert.match(overview.get('Authority Rank')!, /restarts the numbering on each one/);
    assert.match(overview.get('Backlinks per Referring Domain')!, /many links from few sites/);
  });

  it('leaves the dictionary out of a file that has no derived columns', () => {
    const overview = overviewFor({ operation: 'backlinks_comparison', targets: ['a.com'] }, 1);
    assert.equal(overview.has('Market Tier'), false);
    assert.equal(overview.has('Derived columns'), false);
  });
});

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
