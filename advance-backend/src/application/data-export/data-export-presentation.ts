import { normalizeExportCell } from './data-export-cell';
import type { DataExportSource } from './data-export.types';

const SEMRUSH_NUMERIC_COLUMNS = new Set([
  'Position', 'Previous Position', 'Position Difference', 'Search Volume',
  'CPC', 'Traffic (%)', 'Traffic Cost (%)', 'Competition', 'Number of Results',
]);
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
  readonly sourceTruncated: boolean;
}): DataExportPresentation {
  const semrushOrganic = input.source?.kind === 'semrush_snapshot'
    && input.source.args.operation === 'organic_positions';
  const hasTrends = semrushOrganic && input.columns.includes('Trends');
  const mainColumns = hasTrends
    ? input.columns.filter(column => column !== 'Trends')
    : [...input.columns];
  const flatColumns = hasTrends
    ? input.columns.flatMap(column => column === 'Trends' ? TREND_COLUMNS : [column])
    : [...input.columns];
  const overviewRows = input.source?.kind === 'semrush_snapshot'
    ? semrushOverviewRows(input)
    : undefined;

  return {
    dataSheetTitle: semrushOrganic
      ? 'Organic Positions'
      : input.source?.kind === 'semrush_snapshot'
        ? 'Semrush Data'
        : 'Export',
    mainColumns,
    flatColumns,
    ...(overviewRows ? { overviewRows } : {}),
    numberFormats: {
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
      'Traffic (%)': 110,
      'Traffic Cost (%)': 130,
      Competition: 105,
      'Number of Results': 135,
      'SERP Features by Keyword': 220,
      'SERP Features by Position': 220,
      ...Object.fromEntries(TREND_COLUMNS.map(column => [column, 105])),
    },
    ...(hasTrends ? { trends: { title: 'Trends', columns: ['Keyword', 'Url', ...TREND_COLUMNS] } } : {}),
    mainRow: row => mainColumns.map(column => normalizeSourceCell(row[column], column, input.source)),
    flatRow: row => flatColumns.map(column => trendIndex(column) === undefined
      ? normalizeSourceCell(row[column], column, input.source)
      : trendValues(row.Trends)[trendIndex(column) ?? 0]),
    trendRow: row => [
      normalizeSourceCell(row.Keyword, 'Keyword', input.source),
      normalizeSourceCell(row.Url, 'Url', input.source),
      ...trendValues(row.Trends),
    ],
  };
}

function semrushOverviewRows(input: {
  readonly title: string;
  readonly source?: DataExportSource;
  readonly rowCount: number;
  readonly sourceTruncated: boolean;
}): readonly (readonly unknown[])[] | undefined {
  if (input.source?.kind !== 'semrush_snapshot') return undefined;
  const args = input.source.args;
  const subject = 'domain' in args
    ? args.domain
    : 'targets' in args
      ? args.targets.join(', ')
      : args.operation === 'keyword_research'
        ? args.keywords.join(', ')
        : 'Semrush report';
  return [
    [input.title],
    ['Source', 'Semrush API'],
    ['Report', args.operation.replaceAll('_', ' ')],
    ['Subject', subject],
    ['Database', 'database' in args ? args.database ?? 'in' : 'Not applicable'],
    ['Retrieved at', new Date().toISOString()],
    ['Rows exported', input.rowCount],
    ['Completeness', input.sourceTruncated
      ? 'Partial — Divo export safety cap reached'
      : 'Complete for this query'],
    ['Metric note', 'CPC is kept currency-neutral because this report does not identify a currency.'],
    ['Trend note', 'Trend Period 01–12 preserve Semrush provider order; 1.00 is the row peak and lower values are relative interest.'],
  ];
}

function normalizeSourceCell(
  value: unknown,
  column: string,
  source: DataExportSource | undefined,
): unknown {
  if (
    source?.kind === 'semrush_snapshot'
    && typeof value === 'string'
    && SEMRUSH_NUMERIC_COLUMNS.has(column)
    && value.trim() !== ''
  ) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return normalizeExportCell(value);
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
