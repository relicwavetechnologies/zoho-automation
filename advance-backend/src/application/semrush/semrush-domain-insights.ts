/**
 * `domain_overview` answers with one row per country database — 26 for a small
 * domain. Every question a member actually asks of that table ("where do I
 * matter", "where am I ranking without earning", "how concentrated am I") is
 * arithmetic over those rows, and until now nothing did that arithmetic: the
 * export shipped raw counts and the model worked them out in chat from memory.
 * That is where the miscounts came from — a model that says 23 countries and
 * then lists 22.
 *
 * So the arithmetic happens here, once, deterministically. The export gains the
 * derived columns; the chat gains a summary it can read instead of recompute.
 * Nothing here calls Semrush: every value is a function of rows already paid
 * for, so enriching costs no quota.
 */

/** Rows covering this share of organic traffic are the ones worth calling core. */
const CORE_CUMULATIVE_SHARE_PCT = 80;

export const SEMRUSH_TRAFFIC_RANK_COLUMN = 'Traffic Rank';
export const SEMRUSH_TRAFFIC_SHARE_COLUMN = 'Traffic Share %';
export const SEMRUSH_CUMULATIVE_SHARE_COLUMN = 'Cumulative Traffic %';
export const SEMRUSH_TRAFFIC_PER_KEYWORD_COLUMN = 'Traffic per Keyword';
export const SEMRUSH_VALUE_PER_VISIT_COLUMN = 'Value per Visit';
export const SEMRUSH_MARKET_TIER_COLUMN = 'Market Tier';

export const SEMRUSH_DOMAIN_INSIGHT_COLUMNS = [
  SEMRUSH_TRAFFIC_RANK_COLUMN,
  SEMRUSH_TRAFFIC_SHARE_COLUMN,
  SEMRUSH_CUMULATIVE_SHARE_COLUMN,
  SEMRUSH_TRAFFIC_PER_KEYWORD_COLUMN,
  SEMRUSH_VALUE_PER_VISIT_COLUMN,
  SEMRUSH_MARKET_TIER_COLUMN,
] as const;

export type SemrushMarketTier = 'Core' | 'Emerging' | 'Dormant';

export interface SemrushTopCountry {
  readonly database: string;
  readonly organicTraffic: number;
  readonly trafficSharePct: number;
}

export interface SemrushDomainOverviewInsights {
  readonly kind: 'domain_overview';
  readonly countriesReturned: number;
  readonly totalOrganicTraffic: number;
  readonly totalOrganicKeywords: number;
  /** Rows Semrush measured above zero traffic. */
  readonly countriesWithTraffic: number;
  /** Rows Semrush measured at exactly zero traffic — a finding, not an absence. */
  readonly countriesWithZeroTraffic: number;
  /** How few countries it takes to reach 80% of traffic. 0 when there is none. */
  readonly countriesForEightyPercentOfTraffic: number;
  readonly tiers: Readonly<Record<Lowercase<SemrushMarketTier>, number>>;
  readonly topCountries: readonly SemrushTopCountry[];
}

const TOP_COUNTRY_LIMIT = 5;

/**
 * Domain-overview rows and organic-position rows both arrive under the
 * `domain_overview` operation; only the former is a country table. Position
 * rows carry `Trends` and no `Database`, and enriching those would invent a
 * country breakdown out of keyword rows.
 */
export function isSemrushDomainOverviewTable(
  rows: readonly Readonly<Record<string, unknown>>[],
): boolean {
  const first = rows[0];
  if (!first) return false;
  return 'Database' in first && 'Organic Traffic' in first && !('Trends' in first);
}

/**
 * Adds the derived columns. Row order is preserved — the requested country
 * still leads the table — because rank and cumulative share are computed
 * against a traffic-sorted view rather than against display position.
 */
export function enrichSemrushDomainOverviewRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): Array<Record<string, unknown>> {
  if (!isSemrushDomainOverviewTable(rows)) return rows.map(row => ({ ...row }));

  const totalTraffic = rows.reduce((sum, row) => sum + traffic(row), 0);
  const byTrafficDesc = [...rows].sort((a, b) => traffic(b) - traffic(a));

  const rankByRow = new Map<Readonly<Record<string, unknown>>, number>();
  const cumulativeBeforeByRow = new Map<Readonly<Record<string, unknown>>, number>();
  let running = 0;
  byTrafficDesc.forEach((row, index) => {
    rankByRow.set(row, index + 1);
    cumulativeBeforeByRow.set(row, running);
    running += traffic(row);
  });

  return rows.map(row => {
    const organicTraffic = traffic(row);
    const keywords = numeric(row['Organic Keywords']);
    const cost = numeric(row['Organic Cost']);
    const cumulativeBefore = cumulativeBeforeByRow.get(row) ?? 0;

    return {
      ...row,
      [SEMRUSH_TRAFFIC_RANK_COLUMN]: rankByRow.get(row) ?? '',
      [SEMRUSH_TRAFFIC_SHARE_COLUMN]: sharePct(organicTraffic, totalTraffic),
      [SEMRUSH_CUMULATIVE_SHARE_COLUMN]: sharePct(cumulativeBefore + organicTraffic, totalTraffic),
      [SEMRUSH_TRAFFIC_PER_KEYWORD_COLUMN]: ratio(organicTraffic, keywords),
      [SEMRUSH_VALUE_PER_VISIT_COLUMN]: ratio(cost, organicTraffic),
      [SEMRUSH_MARKET_TIER_COLUMN]: tierFor({ organicTraffic, cumulativeBefore, totalTraffic }),
    };
  });
}

/**
 * The counts a member asks for out loud. Handing these to the model as numbers
 * is what stops it counting rows by eye and dropping one.
 */
export function summarizeSemrushDomainOverview(
  rows: readonly Readonly<Record<string, unknown>>[],
): SemrushDomainOverviewInsights | undefined {
  if (!isSemrushDomainOverviewTable(rows)) return undefined;

  const totalOrganicTraffic = rows.reduce((sum, row) => sum + traffic(row), 0);
  const totalOrganicKeywords = rows.reduce((sum, row) => sum + numeric(row['Organic Keywords']), 0);
  const byTrafficDesc = [...rows].sort((a, b) => traffic(b) - traffic(a));

  let running = 0;
  let countriesForEightyPercentOfTraffic = 0;
  const tiers = { core: 0, emerging: 0, dormant: 0 };
  for (const row of byTrafficDesc) {
    const organicTraffic = traffic(row);
    const tier = tierFor({ organicTraffic, cumulativeBefore: running, totalTraffic: totalOrganicTraffic });
    tiers[tier.toLowerCase() as Lowercase<SemrushMarketTier>] += 1;
    if (tier === 'Core') countriesForEightyPercentOfTraffic += 1;
    running += organicTraffic;
  }

  return {
    kind: 'domain_overview',
    countriesReturned: rows.length,
    totalOrganicTraffic,
    totalOrganicKeywords,
    countriesWithTraffic: rows.filter(row => traffic(row) > 0).length,
    countriesWithZeroTraffic: rows.filter(row => traffic(row) === 0).length,
    countriesForEightyPercentOfTraffic,
    tiers,
    topCountries: byTrafficDesc
      .filter(row => traffic(row) > 0)
      .slice(0, TOP_COUNTRY_LIMIT)
      .map(row => ({
        database: String(row.Database ?? ''),
        organicTraffic: traffic(row),
        trafficSharePct: round(percent(traffic(row), totalOrganicTraffic) ?? 0),
      })),
  };
}

/**
 * `Dormant` is a measured zero, which Semrush did report and which may be
 * described as ranking without earning clicks. It never covers a country
 * missing from the table — that country has no row here at all.
 */
function tierFor(input: {
  readonly organicTraffic: number;
  readonly cumulativeBefore: number;
  readonly totalTraffic: number;
}): SemrushMarketTier {
  if (input.organicTraffic <= 0) return 'Dormant';
  if (input.totalTraffic <= 0) return 'Dormant';
  const shareBefore = percent(input.cumulativeBefore, input.totalTraffic) ?? 0;
  return shareBefore < CORE_CUMULATIVE_SHARE_PCT ? 'Core' : 'Emerging';
}

/** Blank rather than 0.00 when there is no total: a share of nothing is not zero. */
function sharePct(value: number, total: number): number | '' {
  const pct = percent(value, total);
  return pct === undefined ? '' : round(pct);
}

function ratio(numerator: number, denominator: number): number | '' {
  if (denominator <= 0) return '';
  return round(numerator / denominator);
}

function percent(value: number, total: number): number | undefined {
  if (total <= 0) return undefined;
  return (value / total) * 100;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function traffic(row: Readonly<Record<string, unknown>>): number {
  return numeric(row['Organic Traffic']);
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
