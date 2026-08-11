/**
 * `backlinks_comparison` answers with one row per target, and a member asking
 * for a ranking wants every one of them back. Narrating that list is where
 * targets go missing: an eleven-site comparison came back describing ten, with
 * technewsera.com dropped silently — every number that was reported was right,
 * so nothing looked wrong.
 *
 * A count alone does not fix a list the way it fixed "how many countries". So
 * the ranking arrives already ordered and already numbered: positions 1..N with
 * no gaps, which makes an omission visible instead of invisible.
 *
 * Nothing here calls Semrush. The ordering and ratios are functions of rows the
 * request already paid for.
 */

const NO_PROVIDER_DATA = 'No provider data';

export const SEMRUSH_AUTHORITY_RANK_COLUMN = 'Authority Rank';
export const SEMRUSH_BACKLINKS_PER_DOMAIN_COLUMN = 'Backlinks per Referring Domain';

export interface SemrushBacklinksRankingEntry {
  readonly position: number;
  readonly target: string;
  /** Null where Semrush returned no report for the target — never 0. */
  readonly authorityScore: number | null;
  readonly backlinks: number | null;
  readonly referringDomains: number | null;
  readonly hasProviderData: boolean;
}

export interface SemrushBacklinksInsights {
  readonly kind: 'backlinks_comparison';
  readonly targetsCompared: number;
  readonly targetsWithProviderData: number;
  readonly targetsWithoutProviderData: readonly string[];
  readonly ranking: readonly SemrushBacklinksRankingEntry[];
}

export function isSemrushBacklinksTable(
  rows: readonly Readonly<Record<string, unknown>>[],
): boolean {
  const first = rows[0];
  return Boolean(first) && 'Target' in first!;
}

/**
 * Ranked by authority score, strongest first. Targets Semrush had no report for
 * sort last and keep null metrics, because a missing report is not a zero score
 * and must not be ranked as the weakest site.
 */
export function summarizeSemrushBacklinks(
  rows: readonly Readonly<Record<string, unknown>>[],
): SemrushBacklinksInsights | undefined {
  if (!isSemrushBacklinksTable(rows)) return undefined;

  const ordered = [...rows].sort(byProviderDataThenAuthority);
  const withoutData = rows.filter(row => !hasProviderData(row)).map(row => String(row.Target ?? ''));

  return {
    kind: 'backlinks_comparison',
    targetsCompared: rows.length,
    targetsWithProviderData: rows.length - withoutData.length,
    targetsWithoutProviderData: withoutData,
    ranking: ordered.map((row, index) => ({
      position: index + 1,
      target: String(row.Target ?? ''),
      authorityScore: metric(row, 'Authority Score'),
      backlinks: metric(row, 'Backlinks'),
      referringDomains: metric(row, 'Referring Domains'),
      hasProviderData: hasProviderData(row),
    })),
  };
}

/**
 * Adds the two columns the raw counters only imply: where a target sits in the
 * ranking, and how many links each referring domain contributes — a high ratio
 * is many links from few sites, which is what a thin backlink profile looks
 * like next to a broad one.
 */
export function enrichSemrushBacklinksRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): Array<Record<string, unknown>> {
  if (!isSemrushBacklinksTable(rows)) return rows.map(row => ({ ...row }));

  const positionByTarget = new Map<string, number>();
  [...rows].sort(byProviderDataThenAuthority).forEach((row, index) => {
    positionByTarget.set(String(row.Target ?? ''), index + 1);
  });

  return rows.map(row => {
    const backlinks = metric(row, 'Backlinks');
    const referringDomains = metric(row, 'Referring Domains');
    return {
      ...row,
      [SEMRUSH_AUTHORITY_RANK_COLUMN]: hasProviderData(row)
        ? positionByTarget.get(String(row.Target ?? '')) ?? ''
        : '',
      [SEMRUSH_BACKLINKS_PER_DOMAIN_COLUMN]: backlinks !== null && referringDomains !== null && referringDomains > 0
        ? Math.round((backlinks / referringDomains) * 100) / 100
        : '',
    };
  });
}

function byProviderDataThenAuthority(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): number {
  const aHas = hasProviderData(a);
  const bHas = hasProviderData(b);
  if (aHas !== bHas) return aHas ? -1 : 1;
  return (metric(b, 'Authority Score') ?? 0) - (metric(a, 'Authority Score') ?? 0);
}

function hasProviderData(row: Readonly<Record<string, unknown>>): boolean {
  return row['Provider Data Status'] !== NO_PROVIDER_DATA;
}

function metric(row: Readonly<Record<string, unknown>>, column: string): number | null {
  if (!hasProviderData(row)) return null;
  const value = row[column];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
