import { normalizeExportCell } from './data-export-cell';
import type { DataExportCoverage, DataExportSource } from './data-export.types';
import type { SemrushOperation } from '../semrush/semrush.types';

const SEMRUSH_DOMAIN_METRIC_COLUMNS = new Set([
  'Rank', 'Organic Keywords', 'Organic Traffic', 'Organic Cost',
  'Adwords Keywords', 'Adwords Traffic', 'Adwords Cost',
  'PLA keywords', 'PLA uniques',
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

export interface DataExportPresentation {
  readonly dataSheetTitle: string;
  readonly mainColumns: readonly string[];
  readonly flatColumns: readonly string[];
  readonly overviewRows?: readonly (readonly unknown[])[];
  readonly numberFormats: Readonly<Record<string, string>>;
  readonly columnWidths: Readonly<Record<string, number>>;
  mainRow(row: Readonly<Record<string, unknown>>): readonly unknown[];
  flatRow(row: Readonly<Record<string, unknown>>): readonly unknown[];
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
  const mainColumns = [...input.columns];
  const overviewRows = semrushSource ? semrushOverviewRows(input) : undefined;

  return {
    dataSheetTitle: semrushSource
      ? SEMRUSH_SHEET_TITLES[semrushSource.args.operation]
      : 'Export',
    mainColumns,
    flatColumns: mainColumns,
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
      Position: '#,##0',
    },
    columnWidths: {
      Keyword: 240,
      Position: 90,
      Target: 180,
      Domain: 180,
      'Authority Score': 110,
      'Referring Domains': 140,
      'Referring URLs': 120,
      'Provider Data Status': 160,
    },
    mainRow: row => mainColumns.map(column => normalizeSourceCell(row[column], column, input.source)),
    flatRow: row => mainColumns.map(column => normalizeSourceCell(row[column], column, input.source)),
  };
}

function semrushOverviewRows(input: {
  readonly title: string;
  readonly source?: DataExportSource;
  readonly rowCount: number;
  readonly coverage?: DataExportCoverage;
  readonly sourceTruncated: boolean;
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
    ['Database', 'database' in args ? args.database ?? 'in' : 'Not applicable'],
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

  return rows;
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
  return SEMRUSH_DOMAIN_METRIC_COLUMNS.has(column)
    || SEMRUSH_BACKLINKS_NUMERIC_COLUMNS.has(column)
    || column === 'Position';
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
