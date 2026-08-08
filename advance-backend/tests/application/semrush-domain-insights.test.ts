import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichSemrushDomainOverviewRows,
  isSemrushDomainOverviewTable,
  summarizeSemrushDomainOverview,
} from '../../src/application/semrush/semrush-domain-insights.ts';

/**
 * Shape and values taken from a live `organic.overview` call for emiactech.com.
 * Totals here are small enough to check by hand, which is the point: every
 * assertion below is arithmetic a reader can redo without running the code.
 *
 * Total organic traffic = 810 + 3 + 2 + 0 = 815.
 */
const liveRows = [
  { Database: 'in', Domain: 'emiactech.com', Rank: 305836, 'Organic Keywords': 53, 'Organic Traffic': 810, 'Organic Cost': 1000 },
  { Database: 'us', Domain: 'emiactech.com', Rank: 10435549, 'Organic Keywords': 105, 'Organic Traffic': 3, 'Organic Cost': 12 },
  { Database: 'ru', Domain: 'emiactech.com', Rank: 2839423, 'Organic Keywords': 6, 'Organic Traffic': 2, 'Organic Cost': 0 },
  { Database: 'ca', Domain: 'emiactech.com', Rank: 4785795, 'Organic Keywords': 9, 'Organic Traffic': 0, 'Organic Cost': 0 },
];

const byDatabase = (rows: ReadonlyArray<Record<string, unknown>>) =>
  Object.fromEntries(rows.map(row => [String(row.Database), row]));

describe('isSemrushDomainOverviewTable', () => {
  it('accepts a country table', () => {
    assert.equal(isSemrushDomainOverviewTable(liveRows), true);
  });

  it('rejects organic-position rows, which carry Trends and no Database', () => {
    // These reach the export under the same operation. Enriching them would
    // invent a country breakdown out of keyword rows.
    assert.equal(
      isSemrushDomainOverviewTable([{ Keyword: 'seo', Position: 4, Trends: '1.00,0.80', 'Organic Traffic': 12 }]),
      false,
    );
  });

  it('rejects an empty result rather than dividing by nothing', () => {
    assert.equal(isSemrushDomainOverviewTable([]), false);
  });
});

describe('enrichSemrushDomainOverviewRows', () => {
  const enriched = byDatabase(enrichSemrushDomainOverviewRows(liveRows));

  it('shares traffic against the table total', () => {
    assert.equal(enriched.in!['Traffic Share %'], 99.39); // 810/815
    assert.equal(enriched.us!['Traffic Share %'], 0.37); //   3/815
    assert.equal(enriched.ru!['Traffic Share %'], 0.25); //   2/815
    assert.equal(enriched.ca!['Traffic Share %'], 0);
  });

  it('accumulates share in traffic order so the column reads as a Pareto curve', () => {
    assert.equal(enriched.in!['Cumulative Traffic %'], 99.39);
    assert.equal(enriched.us!['Cumulative Traffic %'], 99.75);
    assert.equal(enriched.ru!['Cumulative Traffic %'], 100);
  });

  it('ranks by traffic even when the requested country leads the display order', () => {
    // The client sorts the requested database first; rank must not follow that,
    // or asking for Canada would report Canada as the biggest market.
    const canadaFirst = byDatabase(enrichSemrushDomainOverviewRows([
      liveRows[3]!, liveRows[0]!, liveRows[1]!, liveRows[2]!,
    ]));
    assert.equal(canadaFirst.in!['Traffic Rank'], 1);
    assert.equal(canadaFirst.us!['Traffic Rank'], 2);
    assert.equal(canadaFirst.ru!['Traffic Rank'], 3);
    assert.equal(canadaFirst.ca!['Traffic Rank'], 4);
  });

  it('preserves the row order it was handed', () => {
    const order = enrichSemrushDomainOverviewRows(liveRows).map(row => row.Database);
    assert.deepEqual(order, ['in', 'us', 'ru', 'ca']);
  });

  it('divides traffic by keywords to separate ranking from earning', () => {
    assert.equal(enriched.in!['Traffic per Keyword'], 15.28); // 810/53
    assert.equal(enriched.us!['Traffic per Keyword'], 0.03); //  3/105 — many keywords, no clicks
  });

  it('leaves a ratio blank rather than reporting a division by zero', () => {
    assert.equal(enriched.ca!['Value per Visit'], ''); // no traffic to divide cost by
    assert.equal(enriched.in!['Value per Visit'], 1.23); // 1000/810
  });

  it('tiers a measured zero as dormant and never as missing', () => {
    assert.equal(enriched.in!['Market Tier'], 'Core');
    assert.equal(enriched.us!['Market Tier'], 'Emerging');
    assert.equal(enriched.ru!['Market Tier'], 'Emerging');
    assert.equal(enriched.ca!['Market Tier'], 'Dormant');
  });

  it('keeps every original column untouched', () => {
    for (const column of Object.keys(liveRows[0]!)) {
      assert.equal(enriched.in![column], liveRows[0]![column as keyof typeof liveRows[0]]);
    }
  });

  it('reports blank shares rather than a fake 0.00 when nothing has traffic', () => {
    const [row] = enrichSemrushDomainOverviewRows([
      { Database: 'in', 'Organic Keywords': 4, 'Organic Traffic': 0, 'Organic Cost': 0 },
    ]);
    assert.equal(row!['Traffic Share %'], '');
    assert.equal(row!['Market Tier'], 'Dormant');
  });

  it('passes rows through untouched when they are not a country table', () => {
    const positions = [{ Keyword: 'seo', Trends: '1.00', Position: 3 }];
    assert.deepEqual(enrichSemrushDomainOverviewRows(positions), positions);
  });

  it('reads numeric strings, which the provider sometimes sends instead of numbers', () => {
    const rows = byDatabase(enrichSemrushDomainOverviewRows([
      { Database: 'in', 'Organic Keywords': '10', 'Organic Traffic': '75', 'Organic Cost': '0' },
      { Database: 'us', 'Organic Keywords': '5', 'Organic Traffic': '25', 'Organic Cost': '0' },
    ]));
    assert.equal(rows.in!['Traffic Share %'], 75);
    assert.equal(rows.us!['Traffic Share %'], 25);
  });
});

describe('summarizeSemrushDomainOverview', () => {
  const insights = summarizeSemrushDomainOverview(liveRows)!;

  it('counts rows so the model never has to', () => {
    assert.equal(insights.countriesReturned, 4);
    assert.equal(insights.countriesWithTraffic, 3);
    assert.equal(insights.countriesWithZeroTraffic, 1);
    assert.equal(insights.totalOrganicTraffic, 815);
    assert.equal(insights.totalOrganicKeywords, 173);
  });

  it('says how concentrated the traffic is', () => {
    assert.equal(insights.countriesForEightyPercentOfTraffic, 1);
    assert.deepEqual(insights.tiers, { core: 1, emerging: 2, dormant: 1 });
  });

  it('ranks the top countries with their share', () => {
    assert.deepEqual(insights.topCountries, [
      { database: 'in', organicTraffic: 810, trafficSharePct: 99.39 },
      { database: 'us', organicTraffic: 3, trafficSharePct: 0.37 },
      { database: 'ru', organicTraffic: 2, trafficSharePct: 0.25 },
    ]);
  });

  it('leaves zero-traffic countries out of the top list without hiding them from the counts', () => {
    assert.equal(insights.topCountries.some(country => country.database === 'ca'), false);
    assert.equal(insights.countriesReturned, 4);
  });

  it('tier counts always add up to the rows returned', () => {
    const { core, emerging, dormant } = insights.tiers;
    assert.equal(core + emerging + dormant, insights.countriesReturned);
  });

  it('returns nothing for a table it cannot summarise', () => {
    assert.equal(summarizeSemrushDomainOverview([]), undefined);
    assert.equal(summarizeSemrushDomainOverview([{ Keyword: 'seo', Trends: '1.00' }]), undefined);
  });
});
