import { createHash } from 'node:crypto';
import type { DatasetCoverage } from '../data-export/dataset-preview';
import type {
  ShopifyAnalyticsArgs,
  ShopifyCustomersArgs,
  ShopifyCustomersListExportArgs,
  ShopifyOrdersArgs,
  ShopifyOrdersListExportArgs,
} from './shopify.types';

export type ShopifyAnalyticsColumn = {
  readonly name: string;
  readonly displayName: string;
};

export type ShopifyExportArgs =
  | ShopifyAnalyticsArgs
  | ShopifyOrdersListExportArgs
  | ShopifyCustomersListExportArgs;

export type ShopifyExportToolId = 'shopifyAnalytics' | 'shopifyOrders' | 'shopifyCustomers';

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

const SHOPIFY_LIST_EXPORT_PAGE_SIZE = 100;
const SHOPIFY_SEARCH_EXPORT_PAGE_SIZE = 50;

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

export function shopifyAnalyticsExportable(operation: string): boolean {
  return operation !== 'unknown';
}

export function shopifyOrdersExportable(operation: string): boolean {
  return operation === 'list_orders';
}

export function shopifyCustomersExportable(operation: string): boolean {
  return operation === 'list_customers' || operation === 'search_customers';
}

export function shopifyExportTitle(
  toolId: ShopifyExportToolId,
  args: ShopifyExportArgs,
  storeDomain: string,
): string {
  const title = `Shopify ${args.operation.replaceAll('_', ' ')} — ${storeDomain}`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

export function shopifyArgsFingerprint(args: ShopifyExportArgs): string {
  const normalized = canonicalizeForFingerprint(args);
  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

export function shopifyAnalyticsArgsSummary(args: ShopifyAnalyticsArgs): string {
  const period = args.period.kind === 'preset'
    ? args.period.value
    : `${args.period.since}..${args.period.until}`;
  return `${args.operation} (${period})`;
}

export function shopifyOrdersArgsSummary(args: ShopifyOrdersListExportArgs): string {
  const filters = args.filters;
  if (!filters) return args.operation;
  const parts = [
    filters.createdAtMin ? `created>=${filters.createdAtMin}` : '',
    filters.createdAtMax ? `created<=${filters.createdAtMax}` : '',
    filters.updatedAtMin ? `updated>=${filters.updatedAtMin}` : '',
    filters.updatedAtMax ? `updated<=${filters.updatedAtMax}` : '',
    filters.financialStatus ? `financial:${filters.financialStatus}` : '',
    filters.fulfillmentStatus ? `fulfillment:${filters.fulfillmentStatus}` : '',
    filters.tag ? `tag:${filters.tag}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `${args.operation} (${parts.join(', ')})` : args.operation;
}

export function shopifyCustomersArgsSummary(args: ShopifyCustomersListExportArgs): string {
  if (args.operation === 'search_customers') {
    return `${args.operation} (${args.search.field})`;
  }
  const filters = args.filters;
  if (!filters) return args.operation;
  const parts = [
    filters.updatedAtMin ? `updated>=${filters.updatedAtMin}` : '',
    filters.updatedAtMax ? `updated<=${filters.updatedAtMax}` : '',
    filters.tag ? `tag:${filters.tag}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `${args.operation} (${parts.join(', ')})` : args.operation;
}

export function exportReplayArgsForList(
  args: ShopifyOrdersArgs | ShopifyCustomersArgs,
): ShopifyOrdersListExportArgs | ShopifyCustomersListExportArgs {
  if (args.operation === 'list_orders') {
    return {
      connectionId: args.connectionId,
      operation: 'list_orders',
      first: SHOPIFY_LIST_EXPORT_PAGE_SIZE,
      ...(args.filters ? { filters: args.filters } : {}),
    };
  }
  if (args.operation === 'list_customers') {
    return {
      connectionId: args.connectionId,
      operation: 'list_customers',
      first: SHOPIFY_LIST_EXPORT_PAGE_SIZE,
      ...(args.filters ? { filters: args.filters } : {}),
    };
  }
  if (args.operation === 'search_customers') {
    return {
      connectionId: args.connectionId,
      operation: 'search_customers',
      search: args.search,
      first: SHOPIFY_SEARCH_EXPORT_PAGE_SIZE,
    };
  }
  throw new Error(`Shopify list export replay is not supported for operation ${args.operation}.`);
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

function canonicalizeForFingerprint(value: ShopifyExportArgs): unknown {
  const normalized = canonicalize(value) as Record<string, unknown>;
  delete normalized['after'];
  delete normalized['first'];
  return normalized;
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
