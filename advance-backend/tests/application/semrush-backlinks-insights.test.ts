import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichSemrushBacklinksRows,
  isSemrushBacklinksTable,
  summarizeSemrushBacklinks,
} from '../../src/application/semrush/semrush-backlinks-insights.ts';

/**
 * Live values from a real eleven-site comparison. That run reported ten of the
 * eleven — technewsera.com was dropped — while every number it did print was
 * correct, which is why nothing looked wrong.
 */
const liveRows = [
  { Target: 'whatmycarworth.com', 'Authority Score': 2, Backlinks: 664, 'Referring Domains': 240, 'Provider Data Status': 'Returned' },
  { Target: 'giztrendzone.com', 'Authority Score': 2, Backlinks: 3997, 'Referring Domains': 165, 'Provider Data Status': 'Returned' },
  { Target: 'iphone-s.com', 'Authority Score': 3, Backlinks: 1508, 'Referring Domains': 437, 'Provider Data Status': 'Returned' },
  { Target: 'technewsera.com', 'Authority Score': 5, Backlinks: 5120, 'Referring Domains': 960, 'Provider Data Status': 'Returned' },
  { Target: 'theedgesearch.com', 'Authority Score': 22, Backlinks: 29090, 'Referring Domains': 2520, 'Provider Data Status': 'Returned' },
  { Target: 'fiz-x.com', 'Authority Score': 16, Backlinks: 6975, 'Referring Domains': 1424, 'Provider Data Status': 'Returned' },
  { Target: 'gamengadgets.com', 'Authority Score': 19, Backlinks: 4196, 'Referring Domains': 1483, 'Provider Data Status': 'Returned' },
  { Target: 'tierraandlava.com', 'Authority Score': 5, Backlinks: 328, 'Referring Domains': 157, 'Provider Data Status': 'Returned' },
  { Target: 'travelexperta.com', 'Authority Score': 29, Backlinks: 20154, 'Referring Domains': 3680, 'Provider Data Status': 'Returned' },
  { Target: 'manvsclock.com', 'Authority Score': 28, Backlinks: 4283, 'Referring Domains': 1041, 'Provider Data Status': 'Returned' },
  { Target: 'addcrazy.com', 'Authority Score': 3, Backlinks: 10542, 'Referring Domains': 1782, 'Provider Data Status': 'Returned' },
];

describe('isSemrushBacklinksTable', () => {
  it('accepts a comparison table and rejects a country table', () => {
    assert.equal(isSemrushBacklinksTable(liveRows), true);
    assert.equal(isSemrushBacklinksTable([{ Database: 'in', 'Organic Traffic': 1 }]), false);
    assert.equal(isSemrushBacklinksTable([]), false);
  });
});

describe('summarizeSemrushBacklinks', () => {
  const insights = summarizeSemrushBacklinks(liveRows)!;

  it('numbers every target from 1 to N with no gaps', () => {
    assert.equal(insights.targetsCompared, 11);
    assert.deepEqual(
      insights.ranking.map(entry => entry.position),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
  });

  it('ranks strongest authority first', () => {
    assert.deepEqual(insights.ranking.map(entry => entry.target), [
      'travelexperta.com', 'manvsclock.com', 'theedgesearch.com', 'gamengadgets.com',
      'fiz-x.com', 'technewsera.com', 'tierraandlava.com', 'iphone-s.com',
      'addcrazy.com', 'whatmycarworth.com', 'giztrendzone.com',
    ]);
  });

  it('keeps the target that a written answer dropped', () => {
    const dropped = insights.ranking.find(entry => entry.target === 'technewsera.com');
    assert.ok(dropped, 'technewsera.com must be present and positioned');
    assert.equal(dropped.position, 6);
    assert.equal(dropped.authorityScore, 5);
    assert.equal(dropped.backlinks, 5120);
    assert.equal(dropped.referringDomains, 960);
  });

  it('every requested target appears exactly once', () => {
    const targets = insights.ranking.map(entry => entry.target);
    assert.equal(new Set(targets).size, liveRows.length);
    for (const row of liveRows) assert.ok(targets.includes(String(row.Target)));
  });

  it('reports a missing report as null metrics ranked last, never as a zero score', () => {
    const withMissing = summarizeSemrushBacklinks([
      ...liveRows,
      { Target: 'nodata.com', 'Provider Data Status': 'No provider data' },
    ])!;
    const last = withMissing.ranking.at(-1)!;
    assert.equal(last.target, 'nodata.com');
    assert.equal(last.hasProviderData, false);
    assert.equal(last.authorityScore, null);
    assert.equal(last.backlinks, null);
    assert.deepEqual(withMissing.targetsWithoutProviderData, ['nodata.com']);
    assert.equal(withMissing.targetsCompared, 12);
    assert.equal(withMissing.targetsWithProviderData, 11);
    // A site with a real score of 2 must still outrank a site with no report.
    assert.ok(last.position > withMissing.ranking.find(e => e.target === 'giztrendzone.com')!.position);
  });

  it('returns nothing for a table it cannot summarise', () => {
    assert.equal(summarizeSemrushBacklinks([]), undefined);
    assert.equal(summarizeSemrushBacklinks([{ Database: 'in' }]), undefined);
  });
});

describe('enrichSemrushBacklinksRows', () => {
  const byTarget = Object.fromEntries(
    enrichSemrushBacklinksRows(liveRows).map(row => [String(row.Target), row]),
  );

  it('carries the ranking position into the file', () => {
    assert.equal(byTarget['travelexperta.com']!['Authority Rank'], 1);
    assert.equal(byTarget['technewsera.com']!['Authority Rank'], 6);
    assert.equal(byTarget['giztrendzone.com']!['Authority Rank'], 11);
  });

  it('exposes link concentration, which the raw counters only imply', () => {
    // 10542 links from 1782 domains — high authority would not look like this.
    assert.equal(byTarget['addcrazy.com']!['Backlinks per Referring Domain'], 5.92);
    // 20154 from 3680 domains: a broader profile at the top of the ranking.
    assert.equal(byTarget['travelexperta.com']!['Backlinks per Referring Domain'], 5.48);
    assert.equal(byTarget['giztrendzone.com']!['Backlinks per Referring Domain'], 24.22);
  });

  it('leaves a missing report blank rather than ranking it', () => {
    const [row] = enrichSemrushBacklinksRows([
      { Target: 'nodata.com', 'Provider Data Status': 'No provider data' },
    ]);
    assert.equal(row!['Authority Rank'], '');
    assert.equal(row!['Backlinks per Referring Domain'], '');
  });

  it('keeps every original column and passes a country table through untouched', () => {
    assert.equal(byTarget['fiz-x.com']!['Authority Score'], 16);
    assert.equal(byTarget['fiz-x.com']!.Backlinks, 6975);
    const countryRows = [{ Database: 'in', 'Organic Traffic': 5 }];
    assert.deepEqual(enrichSemrushBacklinksRows(countryRows), countryRows);
  });
});
