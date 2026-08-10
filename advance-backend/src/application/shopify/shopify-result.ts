import type { DatasetCoverage } from '../provider-data/dataset-preview';
import type { ShopifyAnalyticsArgs } from './shopify.types';

/** Model-facing Shopify row normalization and truthful preview coverage. */

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

export function flattenShopifyOrderRows(nodes: readonly unknown[]): Record<string, unknown>[] {
  return readRecordNodes(nodes)
    .map(node => {
      const money = readDirectMoney(readRecord(node['currentTotalPriceSet'])?.['shopMoney']);
      return {
        Order: node['name'] ?? null,
        'Created at': node['createdAt'] ?? null,
        'Updated at': node['updatedAt'] ?? null,
        'Financial status': node['displayFinancialStatus'] ?? null,
        'Fulfillment status': node['displayFulfillmentStatus'] ?? null,
        Source: node['sourceName'] ?? null,
        'Total amount': money?.amount ?? null,
        Currency: money?.currencyCode ?? null,
        'Shopify order ID': node['id'] ?? null,
      };
    });
}

export function flattenShopifyCustomerRows(nodes: readonly unknown[]): Record<string, unknown>[] {
  return readRecordNodes(nodes)
    .map(node => {
      const spent = readDirectMoney(node['amountSpent']);
      const tags = node['tags'];
      return {
        'Customer ID': node['id'] ?? null,
        State: node['state'] ?? null,
        Tags: Array.isArray(tags) ? tags.join(', ') : tags ?? null,
        'Created at': node['createdAt'] ?? null,
        'Updated at': node['updatedAt'] ?? null,
        'Amount spent': spent?.amount ?? null,
        Currency: spent?.currencyCode ?? null,
      };
    });
}

export function shopifyAnalyticsPreviewable(operation: string): boolean {
  return operation !== 'unknown';
}

export function shopifyOrdersPreviewable(operation: string): boolean {
  return operation === 'list_orders';
}

export function shopifyCustomersPreviewable(operation: string): boolean {
  return operation === 'list_customers' || operation === 'search_customers';
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

export function previewCoverageForShopifyList(
  hasNextPage: boolean,
  rowCount: number,
): DatasetCoverage {
  if (rowCount === 0) {
    return { kind: 'complete', totalRows: 0 };
  }
  if (hasNextPage) {
    return {
      kind: 'truncated',
      returnedRows: rowCount,
      reason: 'shopify_cursor_pagination',
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

export function readShopifyListNodes(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [];
}


function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readRecordNodes(nodes: readonly unknown[]): Record<string, unknown>[] {
  return nodes
    .map(readRecord)
    .filter((node): node is Record<string, unknown> => node !== undefined);
}

function readDirectMoney(value: unknown): { amount: unknown; currencyCode: unknown } | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  return {
    amount: record['amount'] ?? null,
    currencyCode: record['currencyCode'] ?? null,
  };
}
