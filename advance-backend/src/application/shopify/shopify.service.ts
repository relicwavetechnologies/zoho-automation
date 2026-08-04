import { z } from 'zod';
import type { ToolExecutionContext } from '../tools/tool.contract';
import { ShopifyAdminClient, ShopifyApiError } from '../../infrastructure/shopify/shopify-admin.client';
import { ShopifyConnectionService } from './shopify-connection.service';
import { compileShopifyReport } from './shopify-report.compiler';
import type { ShopifyAnalyticsArgs, ShopifyCustomersArgs, ShopifyOrdersArgs } from './shopify.types';

const tableDataSchema = z.object({
  columns: z.array(z.object({ name: z.string(), dataType: z.string(), displayName: z.string() }).passthrough()),
  rows: z.array(z.record(z.unknown())),
});

const ORDER_HISTORY_WINDOW_MS = 60 * 86_400_000;

export type ShopifyOperationResult = {
  readonly status: 'complete' | 'empty' | 'pending';
  readonly operation: string;
  readonly store: { readonly domain: string; readonly name?: string | undefined };
  readonly apiVersion: string;
  readonly data?: unknown;
  readonly pageInfo?: { readonly hasNextPage: boolean; readonly endCursor?: string | undefined } | undefined;
  readonly queryCost?: Record<string, unknown> | undefined;
  readonly requestId?: string | undefined;
  readonly retrievedAt: string;
  readonly message: string;
};

export class ShopifyServiceError extends Error {
  constructor(
    readonly code:
      | 'bad_args'
      | 'inaccessible'
      | 'authorization_required'
      | 'missing_scope'
      | 'rate_limited'
      | 'provider_failure'
      | 'invalid_response',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ShopifyServiceError';
  }
}

export class ShopifyService {
  constructor(private readonly deps: {
    readonly connections: ShopifyConnectionService;
    readonly client: ShopifyAdminClient;
    readonly apiVersion: string;
    readonly now?: () => Date;
  }) {}

  async analytics(args: ShopifyAnalyticsArgs, ctx: ToolExecutionContext): Promise<ShopifyOperationResult> {
    const shopifyql = compileShopifyReport(args);
    const response = await this.run<{ shopifyqlQuery: { tableData: unknown; parseErrors: string[] } }>({
      args,
      ctx,
      requiredScopes: ['read_reports'],
      query: `query DivoShopifyReport($query: String!) {
        shopifyqlQuery(query: $query) {
          tableData { columns { name dataType displayName } rows }
          parseErrors
        }
      }`,
      variables: { query: shopifyql },
    });
    const report = response.data.shopifyqlQuery;
    if (!report || !Array.isArray(report.parseErrors)) {
      throw new ShopifyServiceError('invalid_response', 'ShopifyQL returned an invalid result.');
    }
    if (report.parseErrors.length > 0) {
      throw new ShopifyServiceError('bad_args', `ShopifyQL rejected the compiled report: ${report.parseErrors.join('; ')}`);
    }
    const table = tableDataSchema.safeParse(report.tableData);
    if (!table.success) throw new ShopifyServiceError('invalid_response', 'ShopifyQL returned no valid table data.');
    return this.result(args.operation, response, {
      shopifyql,
      columns: table.data.columns,
      rows: table.data.rows,
    }, table.data.rows.length === 0 ? 'empty' : 'complete');
  }

  async orders(args: ShopifyOrdersArgs, ctx: ToolExecutionContext): Promise<ShopifyOperationResult> {
    const historyFloor = new Date((this.deps.now?.() ?? new Date()).getTime() - ORDER_HISTORY_WINDOW_MS);
    switch (args.operation) {
      case 'list_orders': {
        const access = resolveOrderListAccess(args.filters, historyFloor);
        const response = await this.run<{ orders: { nodes: unknown[]; pageInfo: PageInfo } }>({
          args, ctx, requiredScopes: access.requiredScopes, query: ORDERS_LIST_QUERY,
          variables: { first: args.first, after: args.after ?? null, query: compileOrderFilters(access.filters) },
        });
        const nodes = ensureNodes(response.data.orders, 'orders');
        return this.result(args.operation, response, nodes, nodes.length === 0 ? 'empty' : 'complete', pageInfo(response.data.orders.pageInfo));
      }
      case 'get_order': {
        const response = await this.run<{ order: unknown | null }>({
          args, ctx, requiredScopes: requiredDirectOrderScopes(args.includeHistorical), query: ORDER_QUERY, variables: { id: args.orderId },
        });
        const order = annotateLineItemTruncation(enforceOrderHistoryBoundary(response.data.order, args.includeHistorical, historyFloor));
        return this.result(args.operation, response, order, order ? 'complete' : 'empty');
      }
      case 'get_order_by_identifier': {
        const requestedNames = orderNameCandidates(args.name);
        for (const [index, requestedName] of requestedNames.entries()) {
          const response = await this.run<{ orders: { nodes: Array<{ name?: unknown }>; pageInfo: PageInfo } }>({
            args, ctx, requiredScopes: requiredDirectOrderScopes(args.includeHistorical), query: ORDER_BY_NAME_QUERY,
            variables: {
              query: [
                `name:${quoteSearch(requestedName)}`,
                args.includeHistorical ? '' : `created_at:>=${historyFloor.toISOString()}`,
              ].filter(Boolean).join(' AND '),
            },
          });
          const matches = ensureNodes(response.data.orders, 'orders').filter(order => (
            order && typeof order === 'object' && (order as Record<string, unknown>)['name'] === requestedName
          ));
          if (matches.length > 1) throw new ShopifyServiceError('invalid_response', 'Shopify returned more than one exact order-name match.');
          const order = enforceOrderHistoryBoundary(matches[0] ?? null, args.includeHistorical, historyFloor);
          if (order || index === requestedNames.length - 1) {
            return this.result(args.operation, response, order, order ? 'complete' : 'empty');
          }
        }
        throw new ShopifyServiceError('invalid_response', 'Shopify order-name lookup did not complete.');
      }
      case 'get_order_attribution': {
        const response = await this.run<{ order: { id: string; name: string; createdAt: string; sourceName?: string | null; app?: { name: string } | null; customerJourneySummary?: { ready: boolean } | null } | null }>({
          args, ctx, requiredScopes: requiredDirectOrderScopes(args.includeHistorical), query: ORDER_ATTRIBUTION_QUERY, variables: { id: args.orderId },
        });
        const order = enforceOrderHistoryBoundary(response.data.order, args.includeHistorical, historyFloor) as typeof response.data.order;
        const summary = order?.customerJourneySummary;
        const status = !order ? 'empty' : summary && !summary.ready ? 'pending' : 'complete';
        return this.result(args.operation, response, order, status);
      }
      case 'list_order_line_items': {
        const response = await this.run<{ order: { id: string; name: string; createdAt: string; lineItems: { nodes: unknown[]; pageInfo: PageInfo } } | null }>({
          args,
          ctx,
          requiredScopes: requiredDirectOrderScopes(args.includeHistorical),
          query: ORDER_LINE_ITEMS_QUERY,
          variables: { id: args.orderId, first: args.first, after: args.after ?? null },
        });
        const order = enforceOrderHistoryBoundary(response.data.order, args.includeHistorical, historyFloor) as typeof response.data.order;
        if (!order) return this.result(args.operation, response, null, 'empty');
        const nodes = ensureNodes(order.lineItems, 'order line items');
        return this.result(args.operation, response, {
          orderId: order.id,
          orderName: order.name,
          lineItems: nodes,
        }, nodes.length === 0 ? 'empty' : 'complete', pageInfo(order.lineItems.pageInfo));
      }
    }
  }

  async customers(args: ShopifyCustomersArgs, ctx: ToolExecutionContext): Promise<ShopifyOperationResult> {
    switch (args.operation) {
      case 'list_customers': {
        const response = await this.run<{ customers: { nodes: unknown[]; pageInfo: PageInfo } }>({
          args, ctx, requiredScopes: ['read_customers'], query: customersQuery(),
          variables: { first: args.first, after: args.after ?? null, query: compileCustomerFilters(args.filters) || null },
        });
        const nodes = ensureNodes(response.data.customers, 'customers');
        return this.result(args.operation, response, nodes, nodes.length === 0 ? 'empty' : 'complete', pageInfo(response.data.customers.pageInfo));
      }
      case 'get_customer': {
        const response = await this.run<{ customer: unknown | null }>({
          args, ctx, requiredScopes: ['read_customers'], query: customerQuery(), variables: { id: args.customerId },
        });
        return this.result(args.operation, response, response.data.customer, response.data.customer ? 'complete' : 'empty');
      }
      case 'search_customers': {
        const response = await this.run<{ customers: { nodes: unknown[]; pageInfo: PageInfo } }>({
          args, ctx, requiredScopes: ['read_customers'], query: customersQuery(),
          variables: { first: args.first, after: args.after ?? null, query: compileCustomerSearch(args.search) },
        });
        const nodes = ensureNodes(response.data.customers, 'customers');
        return this.result(args.operation, response, nodes, nodes.length === 0 ? 'empty' : 'complete', pageInfo(response.data.customers.pageInfo));
      }
      case 'count_customers': {
        const response = await this.run<{ customersCount: { count: number; precision: string } }>({
          args, ctx, requiredScopes: ['read_customers'], query: CUSTOMERS_COUNT_QUERY,
          variables: { query: compileCustomerFilters(args.filters) || null, limit: args.limit },
        });
        if (!response.data.customersCount || !Number.isInteger(response.data.customersCount.count)) {
          throw new ShopifyServiceError('invalid_response', 'Shopify returned an invalid customer count.');
        }
        return this.result(args.operation, response, response.data.customersCount, response.data.customersCount.count === 0 ? 'empty' : 'complete');
      }
    }
  }

  private async run<T>(input: {
    readonly args: { readonly connectionId: string };
    readonly ctx: ToolExecutionContext;
    readonly requiredScopes: readonly string[];
    readonly query: string;
    readonly variables: Record<string, unknown>;
  }): Promise<{ data: T; extensions: Record<string, unknown>; requestId?: string; connection: Awaited<ReturnType<ShopifyConnectionService['resolve']>> }> {
    try {
      let connection = await this.deps.connections.resolve({
        companyId: String(input.ctx.runContext.companyId), userId: String(input.ctx.runContext.userId),
        connectionId: input.args.connectionId, requiredScopes: input.requiredScopes,
        ...(input.ctx.abortSignal ? { abortSignal: input.ctx.abortSignal } : {}),
      });
      try {
        const response = await this.deps.client.query<T>({
          shop: connection.shopDomain, accessToken: connection.accessToken,
          query: input.query, variables: input.variables,
          ...(input.ctx.abortSignal ? { abortSignal: input.ctx.abortSignal } : {}),
        });
        await this.deps.connections.touch(connection.connectionId);
        return { ...response, connection };
      } catch (error) {
        if (!(error instanceof ShopifyApiError) || error.code !== 'unauthorized') throw error;
        connection = await this.deps.connections.resolve({
          companyId: String(input.ctx.runContext.companyId), userId: String(input.ctx.runContext.userId),
          connectionId: input.args.connectionId, requiredScopes: input.requiredScopes, forceRefresh: true,
          ...(input.ctx.abortSignal ? { abortSignal: input.ctx.abortSignal } : {}),
        });
        const retried = await this.deps.client.query<T>({
          shop: connection.shopDomain, accessToken: connection.accessToken,
          query: input.query, variables: input.variables,
          ...(input.ctx.abortSignal ? { abortSignal: input.ctx.abortSignal } : {}),
        });
        await this.deps.connections.touch(connection.connectionId);
        return { ...retried, connection };
      }
    } catch (error) {
      throw normalizeError(error);
    }
  }

  private result(
    operation: string,
    response: { extensions: Record<string, unknown>; requestId?: string; connection: Awaited<ReturnType<ShopifyConnectionService['resolve']>> },
    data: unknown,
    status: ShopifyOperationResult['status'],
    pagination?: ShopifyOperationResult['pageInfo'],
  ): ShopifyOperationResult {
    return {
      status,
      operation,
      store: { domain: response.connection.shopDomain, ...(response.connection.shopName ? { name: response.connection.shopName } : {}) },
      apiVersion: this.deps.apiVersion,
      data,
      ...(pagination ? { pageInfo: pagination } : {}),
      ...(Object.keys(response.extensions).length ? { queryCost: sanitizeCosts(response.extensions) } : {}),
      ...(response.requestId ? { requestId: response.requestId } : {}),
      retrievedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      message: status === 'empty' ? 'Shopify returned no matching records.'
        : status === 'pending' ? 'Shopify is still preparing this order attribution; retry later.'
          : 'Shopify request completed.',
    };
  }
}

type PageInfo = { readonly hasNextPage: boolean; readonly endCursor?: string | null };

const ORDER_SUMMARY_FIELDS = `
  id name createdAt updatedAt sourceName
  displayFinancialStatus displayFulfillmentStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
`;

const ORDERS_LIST_QUERY = `query DivoOrders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
    nodes { ${ORDER_SUMMARY_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ORDER_QUERY = `query DivoOrder($id: ID!) {
  order(id: $id) {
    ${ORDER_SUMMARY_FIELDS}
    app { name }
    tags
    currentSubtotalPriceSet { shopMoney { amount currencyCode } }
    currentTotalTaxSet { shopMoney { amount currencyCode } }
    currentTotalDiscountsSet { shopMoney { amount currencyCode } }
    lineItems(first: 50) { nodes { id name quantity sku } pageInfo { hasNextPage endCursor } }
  }
}`;

const ORDER_BY_NAME_QUERY = `query DivoOrderByName($query: String!) {
  orders(first: 2, query: $query) {
    nodes { ${ORDER_SUMMARY_FIELDS} app { name } tags }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ORDER_LINE_ITEMS_QUERY = `query DivoOrderLineItems($id: ID!, $first: Int!, $after: String) {
  order(id: $id) {
    id name createdAt
    lineItems(first: $first, after: $after) {
      nodes { id name quantity sku }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ORDER_ATTRIBUTION_QUERY = `query DivoOrderAttribution($id: ID!) {
  order(id: $id) {
    id name createdAt sourceName app { name }
    customerJourneySummary {
      ready daysToConversion customerOrderIndex
      firstVisit { source sourceDescription sourceType landingPage referrerUrl utmParameters { source medium campaign content term } }
      lastVisit { source sourceDescription sourceType landingPage referrerUrl utmParameters { source medium campaign content term } }
    }
  }
}`;

const CUSTOMER_BASE_FIELDS = `id state tags createdAt updatedAt amountSpent { amount currencyCode }`;
function customersQuery(): string {
  return `query DivoCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes { ${CUSTOMER_BASE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

function customerQuery(): string {
  return `query DivoCustomer($id: ID!) { customer(id: $id) { ${CUSTOMER_BASE_FIELDS} } }`;
}

const CUSTOMERS_COUNT_QUERY = `query DivoCustomersCount($query: String, $limit: Int!) {
  customersCount(query: $query, limit: $limit) { count precision }
}`;

type OrderListFilters = NonNullable<Extract<ShopifyOrdersArgs, { operation: 'list_orders' }>['filters']>;

function compileOrderFilters(filters: OrderListFilters): string {
  return [
    filters.createdAtMin ? `created_at:>=${filters.createdAtMin}` : '',
    filters.createdAtMax ? `created_at:<=${filters.createdAtMax}` : '',
    filters.updatedAtMin ? `updated_at:>=${filters.updatedAtMin}` : '',
    filters.updatedAtMax ? `updated_at:<=${filters.updatedAtMax}` : '',
    filters.financialStatus ? `financial_status:${filters.financialStatus}` : '',
    filters.fulfillmentStatus ? `fulfillment_status:${filters.fulfillmentStatus}` : '',
    filters.tag ? `tag:${quoteSearch(filters.tag)}` : '',
  ].filter(Boolean).join(' AND ');
}

function compileCustomerFilters(filters: { updatedAtMin?: string | undefined; updatedAtMax?: string | undefined; tag?: string | undefined } | undefined): string {
  if (!filters) return '';
  return [
    filters.updatedAtMin ? `updated_at:>=${filters.updatedAtMin}` : '',
    filters.updatedAtMax ? `updated_at:<=${filters.updatedAtMax}` : '',
    filters.tag ? `tag:${quoteSearch(filters.tag)}` : '',
  ].filter(Boolean).join(' AND ');
}

function compileCustomerSearch(search: Extract<ShopifyCustomersArgs, { operation: 'search_customers' }>['search']): string {
  return `${search.field}:${quoteSearch(search.value)}`;
}

function quoteSearch(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function orderNameCandidates(name: string): readonly string[] {
  if (name.startsWith('#')) return [name];
  return /^\d+$/.test(name) ? [`#${name}`, name] : [name, `#${name}`];
}

function ensureNodes(value: { nodes?: unknown } | null | undefined, label: string): unknown[] {
  if (!value || !Array.isArray(value.nodes)) throw new ShopifyServiceError('invalid_response', `Shopify returned invalid ${label} data.`);
  return value.nodes;
}

function pageInfo(value: PageInfo | undefined): ShopifyOperationResult['pageInfo'] {
  if (!value || typeof value.hasNextPage !== 'boolean') throw new ShopifyServiceError('invalid_response', 'Shopify returned invalid pagination data.');
  return { hasNextPage: value.hasNextPage, ...(value.endCursor ? { endCursor: value.endCursor } : {}) };
}

function resolveOrderListAccess(filters: OrderListFilters | undefined, historyFloor: Date): {
  readonly requiredScopes: readonly string[];
  readonly filters: OrderListFilters;
} {
  const requestedFloor = filters?.createdAtMin ? new Date(filters.createdAtMin) : historyFloor;
  const includesHistoricalOrders = requestedFloor.getTime() < historyFloor.getTime();
  return {
    requiredScopes: includesHistoricalOrders ? ['read_orders', 'read_all_orders'] : ['read_orders'],
    filters: {
      ...filters,
      createdAtMin: (includesHistoricalOrders ? requestedFloor : laterDate(requestedFloor, historyFloor)).toISOString(),
    },
  };
}

function requiredDirectOrderScopes(includeHistorical: boolean): readonly string[] {
  return includeHistorical ? ['read_orders', 'read_all_orders'] : ['read_orders'];
}

function enforceOrderHistoryBoundary(order: unknown, includeHistorical: boolean, historyFloor: Date): unknown | null {
  if (order === null || includeHistorical) return order;
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw new ShopifyServiceError('invalid_response', 'Shopify returned invalid order data.');
  }
  const createdAt = (order as Record<string, unknown>)['createdAt'];
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new ShopifyServiceError('invalid_response', 'Shopify returned an order without a valid createdAt timestamp.');
  }
  return Date.parse(createdAt) < historyFloor.getTime() ? null : order;
}

function laterDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function annotateLineItemTruncation(order: unknown): unknown {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return order;
  const lineItems = (order as Record<string, unknown>)['lineItems'];
  if (!lineItems || typeof lineItems !== 'object' || Array.isArray(lineItems)) return order;
  const page = (lineItems as Record<string, unknown>)['pageInfo'];
  if (!page || typeof page !== 'object' || Array.isArray(page)) return order;
  const hasNextPage = (page as Record<string, unknown>)['hasNextPage'];
  if (typeof hasNextPage !== 'boolean') return order;
  return { ...(order as Record<string, unknown>), lineItemsTruncated: hasNextPage };
}

function sanitizeCosts(extensions: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (extensions['cost'] && typeof extensions['cost'] === 'object') output['graphql'] = extensions['cost'];
  if (extensions['shopifyqlCost'] && typeof extensions['shopifyqlCost'] === 'object') output['shopifyql'] = extensions['shopifyqlCost'];
  return output;
}

function normalizeError(error: unknown): ShopifyServiceError {
  if (error instanceof ShopifyServiceError) return error;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : 'Shopify request failed.';
    if (code === 'inaccessible' || code === 'missing_scope' || code === 'authorization_required') {
      return new ShopifyServiceError(code, message, error);
    }
    if (code === 'rate_limited') return new ShopifyServiceError('rate_limited', message, error);
    if (code === 'invalid_response') return new ShopifyServiceError('invalid_response', message, error);
  }
  return new ShopifyServiceError('provider_failure', error instanceof Error ? error.message : 'Shopify request failed.', error);
}
