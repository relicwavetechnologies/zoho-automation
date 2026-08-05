import { createHash } from 'node:crypto';
import type { DatasetCoverage } from '../data-export/dataset-preview';
import type { ShopifyAnalyticsArgs } from './shopify.types';

export type ShopifyAnalyticsColumn = {
  readonly name: string;
  readonly displayName: string;
};

const RANKED_ANALYTICS_OPERATIONS = new Set<ShopifyAnalyticsArgs['operation']>([
  'sales_by_channel',
  'sales_attribution',
  'sales_by_utm',
  'product_performance',
  'inventory_position',
  'payments_by_method',
]);

const ANALYTICS_LIMIT_MAX: Partial<Record<ShopifyAnalyticsArgs['operation'], number>> = {
  sales_by_channel: 100,
  sales_attribution: 100,
  sales_by_utm: 100,
  product_performance: 200,
  inventory_position: 200,
  payments_by_method: 200,
};

export function flattenShopifyAnalyticsRows(
  columns: readonly ShopifyAnalyticsColumn[],
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const headers = columns.map(column => column.displayName || column.name);
  return rows.map(row => {
    const flat: Record<string, unknown> = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index]!;
      flat[headers[index]!] = row[column.name];
    }
    return flat;
  });
}

export function shopifyAnalyticsExportable(operation: string): boolean {
  return operation !== 'unknown';
}

export function shopifyExportTitle(
  toolId: 'shopifyAnalytics',
  args: ShopifyAnalyticsArgs,
  storeDomain: string,
): string {
  const title = `Shopify ${args.operation.replaceAll('_', ' ')} — ${storeDomain}`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

export function shopifyArgsFingerprint(args: ShopifyAnalyticsArgs): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(args)))
    .digest('hex');
}

export function shopifyAnalyticsArgsSummary(args: ShopifyAnalyticsArgs): string {
  const period = args.period.kind === 'preset'
    ? args.period.value
    : `${args.period.since}..${args.period.until}`;
  return `${args.operation} (${period})`;
}

export function previewCoverageForAnalytics(
  args: ShopifyAnalyticsArgs,
  rowCount: number,
): DatasetCoverage {
  if (rowCount === 0) {
    return { kind: 'complete', totalRows: 0 };
  }
  if (!RANKED_ANALYTICS_OPERATIONS.has(args.operation)) {
    return { kind: 'complete', totalRows: rowCount };
  }
  const limit = 'limit' in args ? args.limit : undefined;
  const max = ANALYTICS_LIMIT_MAX[args.operation];
  if (limit !== undefined && max !== undefined && limit < max) {
    return {
      kind: 'provider_limited',
      returnedRows: rowCount,
      reason: 'shopify_ranked_top_n',
    };
  }
  return { kind: 'complete', totalRows: rowCount };
}

export function readShopifyAnalyticsTable(data: unknown): {
  readonly columns: ShopifyAnalyticsColumn[];
  readonly rows: Record<string, unknown>[];
} | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record['columns']) || !Array.isArray(record['rows'])) return null;
  const columns = record['columns']
    .filter((column): column is ShopifyAnalyticsColumn => (
      Boolean(column)
      && typeof column === 'object'
      && typeof (column as ShopifyAnalyticsColumn).name === 'string'
      && typeof (column as ShopifyAnalyticsColumn).displayName === 'string'
    ));
  const rows = record['rows'].filter((row): row is Record<string, unknown> => (
    Boolean(row) && typeof row === 'object' && !Array.isArray(row)
  ));
  return { columns, rows };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((normalized, key) => {
        normalized[key] = canonicalize(record[key]);
        return normalized;
      }, {});
  }
  return value;
}
