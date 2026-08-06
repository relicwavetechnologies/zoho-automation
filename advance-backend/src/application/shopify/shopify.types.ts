import { z } from 'zod';
import { isShopifyGraphqlId } from '../../domain/shopify/shopify-shop';

const connectionId = z.string().uuid();
const cursor = z.string().min(1).max(2_000);
const isoDateTime = z.string().datetime({ offset: true });
const calendarDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Expected a real calendar date.');
const relativePeriodStart = z.string().regex(/^-\d{1,4}[dwmqy]$/);

export const ShopifyPeriodSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preset'),
    value: z.enum(['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_week', 'last_month', 'month_to_date', 'quarter_to_date', 'year_to_date']),
  }).strict(),
  z.object({
    kind: z.literal('range'),
    since: z.union([relativePeriodStart, calendarDate]),
    until: z.union([z.enum(['today', 'yesterday']), calendarDate]).default('today'),
  }).strict(),
]).superRefine((period, ctx) => {
  const span = periodSpanDays(period);
  if (span !== undefined && span > 1_825) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Shopify report periods are limited to five years.' });
  }
  if (period.kind === 'range' && /^\d{4}-\d{2}-\d{2}$/.test(period.since)) {
    const today = new Date().toISOString().slice(0, 10);
    if (period.since > today) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['since'], message: 'since cannot be in the future.' });
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(period.until) && period.since > period.until) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['until'], message: 'until must be on or after since.' });
    }
  }
});

const salesMetric = z.enum([
  'total_sales',
  'gross_sales',
  'net_sales',
  'orders',
  'discounts',
  'sales_reversals',
  'taxes',
]);

const channelDimension = z.enum([
  'sales_channel',
  'referring_channel',
  'referring_medium',
  'referring_platform',
  'traffic_type',
]);

const utmDimension = z.enum([
  'order_utm_source',
  'order_utm_medium',
  'order_utm_campaign',
  'order_utm_content',
  'order_utm_term',
]);

const productMetric = z.enum([
  'total_sales', 'gross_sales', 'net_sales', 'orders', 'net_items_sold', 'average_order_value',
]);
const productDimension = z.enum([
  'product_title', 'product_variant_title', 'product_variant_sku', 'product_vendor', 'product_type',
]);
const customerMetric = z.enum([
  'new_customer_records', 'percent_of_customers', 'total_number_of_orders',
  'total_amount_spent', 'total_amount_spent_per_order', 'days_since_last_order',
]);
const inventoryMetric = z.enum([
  'ending_inventory_units_at_location', 'starting_inventory_units_at_location',
  'inventory_units_net_change_at_location', 'ending_inventory_value_at_location',
  'ending_inventory_retail_value_at_location', 'days_in_inventory_at_location',
  'days_in_stock_at_location', 'days_out_of_stock_at_location',
  'days_of_inventory_remaining_at_location',
]);
const inventoryDimension = z.enum([
  'inventory_location_name', 'inventory_item_id', 'product_id', 'product_title',
  'product_variant_id', 'product_variant_title', 'product_variant_sku',
]);
const paymentMetric = z.enum([
  'gross_payments', 'refunded_payments', 'net_payments', 'net_payments_excluding_gift_cards',
  'orders_with_transactions', 'redeemed_gift_card_value', 'refunded_gift_card_value',
  'rounded_net_payments', 'transaction_amount', 'transactions',
]);
const paymentDimension = z.enum([
  'payment_method', 'payment_gateway', 'credit_card_type', 'digital_wallet',
  'is_shop_pay_transaction', 'pos_location_name',
]);

export const ShopifyAnalyticsArgsSchema = z.discriminatedUnion('operation', [
  z.object({
    connectionId,
    operation: z.literal('sales_summary'),
    metrics: z.array(salesMetric).min(1).max(7).default(['total_sales']),
    period: ShopifyPeriodSchema,
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('sales_timeseries'),
    metrics: z.array(salesMetric).min(1).max(7).default(['total_sales', 'orders']),
    granularity: z.enum(['day', 'week', 'month']),
    period: ShopifyPeriodSchema,
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('sales_by_channel'),
    metrics: z.array(salesMetric).min(1).max(7).default(['total_sales']),
    dimension: channelDimension,
    period: ShopifyPeriodSchema,
    limit: z.number().int().min(1).max(100).default(25),
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('sales_attribution'),
    metric: salesMetric.default('total_sales'),
    dimension: z.enum(['referring_channel', 'referring_medium', 'referring_platform']),
    attribution: z.enum(['FIRST_CLICK_ATTRIBUTION', 'LAST_CLICK_ATTRIBUTION', 'LAST_NON_DIRECT_CLICK_ATTRIBUTION', 'LINEAR_ATTRIBUTION']),
    period: ShopifyPeriodSchema,
    limit: z.number().int().min(1).max(100).default(25),
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('sales_by_utm'),
    metrics: z.array(salesMetric).min(1).max(7).default(['total_sales', 'orders']),
    dimensions: z.array(utmDimension).min(1).max(3),
    period: ShopifyPeriodSchema,
    limit: z.number().int().min(1).max(100).default(50),
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('product_performance'),
    metrics: z.array(productMetric).min(1).max(6).default(['net_sales', 'orders', 'net_items_sold']),
    dimensions: z.array(productDimension).min(1).max(2).default(['product_title']),
    period: ShopifyPeriodSchema,
    limit: z.number().int().min(1).max(200).default(25),
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('customer_acquisition'),
    metrics: z.array(customerMetric).min(1).max(6).default(['new_customer_records', 'percent_of_customers']),
    granularity: z.enum(['day', 'week', 'month']),
    period: ShopifyPeriodSchema,
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('inventory_position'),
    metrics: z.array(inventoryMetric).min(1).max(6).default(['ending_inventory_units_at_location', 'inventory_units_net_change_at_location']),
    dimensions: z.array(inventoryDimension).min(1).max(3).default(['inventory_location_name', 'product_variant_id']),
    period: ShopifyPeriodSchema,
    limit: z.number().int().min(1).max(200).default(100),
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('payments_summary'),
    metrics: z.array(paymentMetric).min(1).max(10).default(['gross_payments', 'refunded_payments', 'net_payments', 'transactions']),
    period: ShopifyPeriodSchema,
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('payments_by_method'),
    metrics: z.array(paymentMetric).min(1).max(10).default(['net_payments', 'transactions', 'orders_with_transactions']),
    dimensions: z.array(paymentDimension).min(1).max(3).default(['payment_method']),
    period: ShopifyPeriodSchema,
    limit: z.number().int().min(1).max(200).default(50),
  }).strict(),
]).superRefine((args, ctx) => {
  if (args.operation !== 'sales_timeseries' && args.operation !== 'customer_acquisition') return;
  const days = periodSpanDays(args.period);
  const maximum = args.granularity === 'day' ? 366 : args.granularity === 'week' ? 1_095 : 1_825;
  if (days !== undefined && days > maximum) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['period'],
      message: `${args.granularity} timeseries would exceed the bounded reporting window.`,
    });
  }
});

const orderFilters = z.object({
  createdAtMin: isoDateTime.optional(),
  createdAtMax: isoDateTime.optional(),
  updatedAtMin: isoDateTime.optional(),
  updatedAtMax: isoDateTime.optional(),
  financialStatus: z.enum(['authorized', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided', 'pending']).optional(),
  fulfillmentStatus: z.enum(['fulfilled', 'unfulfilled', 'partial']).optional(),
  tag: z.string().trim().min(1).max(100).optional(),
}).strict();

const orderId = z.string().refine(value => isShopifyGraphqlId(value, 'Order'), 'Expected a Shopify Order GraphQL ID.');

export const ShopifyOrdersArgsSchema = z.discriminatedUnion('operation', [
  z.object({ connectionId, operation: z.literal('list_orders'), first: z.number().int().min(1).max(100).default(25), after: cursor.optional(), filters: orderFilters.optional() }).strict(),
  z.object({ connectionId, operation: z.literal('get_order'), orderId, includeHistorical: z.boolean().default(false) }).strict(),
  z.object({ connectionId, operation: z.literal('get_order_by_identifier'), name: z.string().trim().regex(/^#?[A-Za-z0-9_-]{1,64}$/), includeHistorical: z.boolean().default(false) }).strict(),
  z.object({ connectionId, operation: z.literal('get_order_attribution'), orderId, includeHistorical: z.boolean().default(false) }).strict(),
  z.object({ connectionId, operation: z.literal('list_order_line_items'), orderId, first: z.number().int().min(1).max(100).default(50), after: cursor.optional(), includeHistorical: z.boolean().default(false) }).strict(),
]);

const customerFilters = z.object({
  updatedAtMin: isoDateTime.optional(),
  updatedAtMax: isoDateTime.optional(),
  tag: z.string().trim().min(1).max(100).optional(),
}).strict();

const customerId = z.string().refine(value => isShopifyGraphqlId(value, 'Customer'), 'Expected a Shopify Customer GraphQL ID.');

const customerSearch = z.discriminatedUnion('field', [
  z.object({ field: z.literal('email'), value: z.string().trim().email().max(254) }).strict(),
  z.object({ field: z.literal('phone'), value: z.string().trim().regex(/^\+?[0-9 ()-]{7,30}$/) }).strict(),
  z.object({ field: z.literal('name'), value: z.string().trim().min(1).max(120) }).strict(),
]);

export const ShopifyCustomersArgsSchema = z.discriminatedUnion('operation', [
  z.object({ connectionId, operation: z.literal('list_customers'), first: z.number().int().min(1).max(100).default(25), after: cursor.optional(), filters: customerFilters.optional() }).strict(),
  z.object({ connectionId, operation: z.literal('get_customer'), customerId }).strict(),
  z.object({ connectionId, operation: z.literal('search_customers'), search: customerSearch, first: z.number().int().min(1).max(50).default(10), after: cursor.optional() }).strict(),
  z.object({
    connectionId,
    operation: z.literal('count_customers'),
    filters: customerFilters.optional(),
    limit: z.number().int().min(1).max(10_000).default(10_000),
  }).strict(),
]);

export const ShopifyOrdersListExportArgsSchema = z.object({
  connectionId,
  operation: z.literal('list_orders'),
  first: z.number().int().min(1).max(100).default(100),
  filters: orderFilters.optional(),
}).strict();

export const ShopifyCustomersListExportArgsSchema = z.discriminatedUnion('operation', [
  z.object({
    connectionId,
    operation: z.literal('list_customers'),
    first: z.number().int().min(1).max(100).default(100),
    filters: customerFilters.optional(),
  }).strict(),
  z.object({
    connectionId,
    operation: z.literal('search_customers'),
    search: customerSearch,
    first: z.number().int().min(1).max(50).default(50),
  }).strict(),
]);

export type ShopifyAnalyticsArgs = z.infer<typeof ShopifyAnalyticsArgsSchema>;
export type ShopifyOrdersArgs = z.infer<typeof ShopifyOrdersArgsSchema>;
export type ShopifyCustomersArgs = z.infer<typeof ShopifyCustomersArgsSchema>;
export type ShopifyOrdersListExportArgs = z.infer<typeof ShopifyOrdersListExportArgsSchema>;
export type ShopifyCustomersListExportArgs = z.infer<typeof ShopifyCustomersListExportArgsSchema>;

function periodSpanDays(period: z.infer<typeof ShopifyPeriodSchema>): number | undefined {
  if (period.kind !== 'range') return undefined;
  const relative = /^-(\d{1,4})([dwmqy])$/.exec(period.since);
  if (relative) {
    const unitDays = { d: 1, w: 7, m: 31, q: 92, y: 365 } as const;
    return Number(relative[1]) * unitDays[relative[2] as keyof typeof unitDays];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.since)) return undefined;
  const until = /^\d{4}-\d{2}-\d{2}$/.test(period.until)
    ? period.until
    : new Date().toISOString().slice(0, 10);
  return Math.max(0, Math.ceil((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${period.since}T00:00:00Z`)) / 86_400_000));
}
