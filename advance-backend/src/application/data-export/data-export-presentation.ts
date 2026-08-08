import { normalizeExportCell } from './data-export-cell';
import type { DataExportCoverage, DataExportSource } from './data-export.types';
import type { SemrushOperation, SemrushToolArgs } from '../semrush/semrush.types';

const SEMRUSH_NUMERIC_COLUMNS = new Set([
  'Position', 'Previous Position', 'Position Difference', 'Search Volume',
  'CPC', 'Traffic (%)', 'Traffic Cost (%)', 'Competition', 'Number of Results',
]);
const SEMRUSH_DOMAIN_METRIC_COLUMNS = new Set([
  'Rank', 'Organic Keywords', 'Organic Traffic', 'Organic Cost',
  'Adwords Keywords', 'Adwords Traffic', 'Adwords Cost',
  'PLA keywords', 'PLA uniques',
  'Traffic Rank', 'Traffic Share %', 'Cumulative Traffic %',
  'Traffic per Keyword', 'Value per Visit',
]);
const SEMRUSH_BACKLINKS_NUMERIC_COLUMNS = new Set([
  'Authority Score', 'Backlinks', 'Referring Domains', 'Referring URLs', 'Referring IPs',
  'Follow Links', 'Nofollow Links', 'Text Links', 'Image Links',
  'ascore', 'total', 'domains_num', 'urls_num', 'ips_num',
  'follows_num', 'nofollows_num', 'texts_num', 'images_num',
]);
const SEMRUSH_SHEET_TITLES: Record<SemrushOperation, string> = {
  domain_overview: 'Domain Overview',
  backlinks_comparison: 'Backlinks Comparison',
  keyword_position_trend: 'Keyword Position Trend',
};
const TREND_PERIOD_COUNT = 12;
const TREND_COLUMNS = Array.from(
  { length: TREND_PERIOD_COUNT },
  (_, index) => `Trend Period ${String(index + 1).padStart(2, '0')}`,
);

export interface DataExportPresentation {
  readonly dataSheetTitle: string;
  readonly mainColumns: readonly string[];
  readonly flatColumns: readonly string[];
  readonly overviewRows?: readonly (readonly unknown[])[];
  readonly numberFormats: Readonly<Record<string, string>>;
  readonly columnWidths: Readonly<Record<string, number>>;
  readonly trends?: {
    readonly title: string;
    readonly columns: readonly string[];
  };
  mainRow(row: Readonly<Record<string, unknown>>): readonly unknown[];
  flatRow(row: Readonly<Record<string, unknown>>): readonly unknown[];
  trendRow(row: Readonly<Record<string, unknown>>): readonly unknown[];
}

export function buildDataExportPresentation(input: {
  readonly title: string;
  readonly columns: readonly string[];
  readonly source?: DataExportSource;
  readonly rowCount: number;
  readonly coverage?: DataExportCoverage;
  readonly sourceTruncated: boolean;
}): DataExportPresentation {
  const semrushSource = input.source?.kind === 'semrush_snapshot' ? input.source : undefined;
  const hasTrends = semrushSource !== undefined && input.columns.includes('Trends');
  const trendIdentityColumns = hasTrends
    ? [
      ...(input.columns.includes('Keyword') ? ['Keyword'] as const : []),
      ...(input.columns.includes('Url') ? ['Url'] as const : []),
    ]
    : [];
  const mainColumns = hasTrends
    ? input.columns.filter(column => column !== 'Trends')
    : [...input.columns];
  const flatColumns = hasTrends
    ? input.columns.flatMap(column => column === 'Trends' ? TREND_COLUMNS : [column])
    : [...input.columns];
  const overviewRows = semrushSource ? semrushOverviewRows({ ...input, hasTrends }) : undefined;

  return {
    dataSheetTitle: semrushSource
      ? semrushDataSheetTitle(semrushSource.args.operation, hasTrends)
      : 'Export',
    mainColumns,
    flatColumns,
    ...(overviewRows ? { overviewRows } : {}),
    numberFormats: {
      Rank: '#,##0',
      'Organic Keywords': '#,##0',
      'Organic Traffic': '#,##0',
      'Organic Cost': '#,##0',
      'Adwords Keywords': '#,##0',
      'Adwords Traffic': '#,##0',
      'Adwords Cost': '#,##0',
      'PLA keywords': '#,##0',
      'PLA uniques': '#,##0',
      'Authority Score': '#,##0',
      Backlinks: '#,##0',
      'Referring Domains': '#,##0',
      'Referring URLs': '#,##0',
      'Referring IPs': '#,##0',
      'Follow Links': '#,##0',
      'Nofollow Links': '#,##0',
      'Text Links': '#,##0',
      'Image Links': '#,##0',
      'Traffic Rank': '#,##0',
      'Traffic Share %': '0.00"%"',
      'Cumulative Traffic %': '0.00"%"',
      'Traffic per Keyword': '0.00',
      'Value per Visit': '0.00',
      Position: '#,##0',
      'Previous Position': '#,##0',
      'Position Difference': '#,##0;[Red]-#,##0',
      'Search Volume': '#,##0',
      CPC: '0.00',
      'Traffic (%)': '0.00"%"',
      'Traffic Cost (%)': '0.00"%"',
      Competition: '0.00',
      'Number of Results': '#,##0',
      ...Object.fromEntries(TREND_COLUMNS.map(column => [column, '0.00'])),
    },
    columnWidths: {
      Keyword: 240,
      Position: 90,
      'Previous Position': 120,
      'Position Difference': 130,
      'Search Volume': 120,
      CPC: 90,
      Url: 380,
      Target: 180,
      Domain: 180,
      'Traffic (%)': 110,
      'Traffic Cost (%)': 130,
      Competition: 105,
      'Number of Results': 135,
      'Authority Score': 110,
      'Referring Domains': 140,
      'Referring URLs': 120,
      'SERP Features by Keyword': 220,
      'SERP Features by Position': 220,
      'Provider Data Status': 160,
      'Traffic Rank': 100,
      'Traffic Share %': 115,
      'Cumulative Traffic %': 155,
      'Traffic per Keyword': 150,
      'Value per Visit': 120,
      'Market Tier': 110,
      ...Object.fromEntries(TREND_COLUMNS.map(column => [column, 105])),
    },
    ...(hasTrends ? { trends: { title: 'Trends', columns: [...trendIdentityColumns, ...TREND_COLUMNS] } } : {}),
    mainRow: row => mainColumns.map(column => normalizeSourceCell(row[column], column, input.source)),
    flatRow: row => flatColumns.map(column => trendIndex(column) === undefined
      ? normalizeSourceCell(row[column], column, input.source)
      : trendValues(row.Trends)[trendIndex(column) ?? 0]),
    trendRow: row => [
      ...trendIdentityColumns.map(column => normalizeSourceCell(row[column], column, input.source)),
      ...trendValues(row.Trends),
    ],
  };
}

function semrushDataSheetTitle(operation: SemrushOperation, hasTrends: boolean): string {
  if (operation === 'domain_overview' && hasTrends) return 'Organic Positions';
  return SEMRUSH_SHEET_TITLES[operation];
}

function semrushOverviewRows(input: {
  readonly title: string;
  readonly columns: readonly string[];
  readonly source?: DataExportSource;
  readonly rowCount: number;
  readonly coverage?: DataExportCoverage;
  readonly sourceTruncated: boolean;
  readonly hasTrends: boolean;
}): readonly (readonly unknown[])[] | undefined {
  if (input.source?.kind !== 'semrush_snapshot') return undefined;
  const args = input.source.args;
  const subject = 'domain' in args
    ? args.domain
    : args.targets.join(', ');
  const rows: unknown[][] = [
    [input.title],
    ['Source', 'Semrush web'],
    ['Report', args.operation.replaceAll('_', ' ')],
    ['Subject', subject],
    ['Database', semrushDatabaseLabel(args)],
    ['Retrieved at', new Date().toISOString()],
    ['Rows exported', input.rowCount],
    ['Completeness', coverageLabel(input.coverage, input.sourceTruncated)],
  ];

  if (args.operation === 'backlinks_comparison') {
    rows.push([
      'Billing note',
      'One Semrush web request covers all targets in this comparison.',
    ]);
  }
  if (args.operation === 'keyword_position_trend') {
    rows.push([
      'Scope note',
      `Keyword "${args.keyword}" on ${args.date} for ${args.domain}.`,
    ]);
  }
  if (args.operation === 'domain_overview') {
    rows.push([
      'Scope note',
      'One row per country database Semrush holds this domain in. The requested '
      + 'database leads; the rest follow by organic traffic. A country absent here '
      + 'is one Semrush has no record for, which is not the same as zero traffic.',
    ]);
  }
  // A derived column a reader cannot check is worse than no column: they either
  // trust a number they cannot reproduce, or ignore the whole sheet. So each one
  // ships with the arithmetic that produced it, in the file itself — the file
  // outlives the chat that explained it.
  if (input.columns.includes('Market Tier')) {
    rows.push(
      [],
      ['Derived columns', 'Calculated by Divo from the rows in this file. No extra Semrush request was made.'],
      ['Traffic Rank', 'Position by organic traffic, highest first, independent of the row order above.'],
      ['Traffic Share %', "This country's organic traffic as a percentage of the total across all rows here."],
      ['Cumulative Traffic %', 'Running share once countries are added highest-traffic first. Reads the concentration of the domain.'],
      ['Traffic per Keyword', 'Organic traffic divided by organic keywords. A low value means the domain ranks without earning clicks.'],
      ['Value per Visit', 'Organic cost divided by organic traffic. Blank where there is no traffic to divide by.'],
      ['Market Tier', 'Core = inside the first 80% of traffic. Emerging = has traffic, beyond that 80%. Dormant = Semrush measured exactly zero traffic.'],
      ['Dormant vs absent', 'Dormant is a measured zero and can be reported as ranking without clicks. A country with no row here was never measured, and is not dormant.'],
    );
  }
  if (args.operation === 'domain_overview' && input.hasTrends) {
    rows.push([
      'Trend note',
      'Trend Period 01–12 preserve Semrush provider order; 1.00 is the row peak and lower values are relative interest.',
    ]);
  }
  if (usesCpcColumn(args.operation)) {
    rows.push([
      'Metric note',
      'CPC is kept currency-neutral because this report does not identify a currency.',
    ]);
  }

  return rows;
}

/**
 * `domain_overview` returns a row per country database, so naming only the
 * requested one described a single-country file that this is not — a reader
 * would take a 26-country sheet for Indian data. Every other operation is
 * genuinely scoped to the database it was asked for.
 */
function semrushDatabaseLabel(args: SemrushToolArgs): string {
  if (!('database' in args)) return 'Not applicable';
  const requested = args.database ?? 'in';
  return args.operation === 'domain_overview'
    ? `${requested} first, then every other country Semrush holds`
    : requested;
}

function usesCpcColumn(operation: string): boolean {
  return operation === 'domain_overview' || operation === 'keyword_position_trend';
}

function coverageLabel(
  coverage: DataExportCoverage | undefined,
  sourceTruncated: boolean,
): string {
  if (!coverage) return sourceTruncated
    ? 'Partial — coverage cause was not recorded'
    : 'Complete for this query';
  if (coverage.outcome === 'complete') return 'Complete for this query';
  if (coverage.outcome === 'requested_window_satisfied') return 'Requested row window satisfied';
  if (!coverage.cause) return 'Partial — coverage cause was not recorded';
  return {
    provider_limit: 'Partial — provider limit reached',
    export_row_cap: 'Partial — Divo export row cap reached',
    destination_row_cap: 'Partial — destination row cap reached',
    destination_cell_cap: 'Partial — destination cell cap reached',
    spool_cap: 'Partial — Divo export spool cap reached',
  }[coverage.cause];
}

function normalizeSourceCell(
  value: unknown,
  column: string,
  source: DataExportSource | undefined,
): unknown {
  if (source?.kind === 'semrush_snapshot' && column === 'Date' && typeof value === 'string') {
    const formatted = formatSemrushDate(value);
    if (formatted) return formatted;
  }
  if (
    source?.kind === 'semrush_snapshot'
    && typeof value === 'string'
    && isSemrushNumericColumn(column)
  ) {
    return semrushNumericValue(value);
  }
  return normalizeExportCell(value);
}

function isSemrushNumericColumn(column: string): boolean {
  return SEMRUSH_NUMERIC_COLUMNS.has(column)
    || SEMRUSH_DOMAIN_METRIC_COLUMNS.has(column)
    || SEMRUSH_BACKLINKS_NUMERIC_COLUMNS.has(column);
}

function semrushNumericValue(value: string): unknown {
  const trimmed = value.trim();
  const sentinel = trimmed.toLowerCase();
  if (trimmed === '' || sentinel === '-' || sentinel === 'n/a' || sentinel === 'na') return '';
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  return normalizeExportCell(value);
}

function formatSemrushDate(value: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function trendValues(value: unknown): readonly unknown[] {
  const values = typeof value === 'string' ? value.split(',') : [];
  return TREND_COLUMNS.map((_, index) => {
    const raw = values[index]?.trim() ?? '';
    if (raw === '') return '';
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : normalizeExportCell(raw);
  });
}

function trendIndex(column: string): number | undefined {
  const index = TREND_COLUMNS.indexOf(column);
  return index >= 0 ? index : undefined;
}
