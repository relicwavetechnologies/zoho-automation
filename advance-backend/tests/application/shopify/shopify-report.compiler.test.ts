import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ShopifyAnalyticsArgsSchema,
  type ShopifyAnalyticsArgs,
} from '../../../src/application/shopify/shopify.types';
import { compileShopifyReport } from '../../../src/application/shopify/shopify-report.compiler';

const connectionId = '11111111-1111-4111-8111-111111111111';
const lastMonth = { kind: 'preset' as const, value: 'last_month' as const };

function parse(input: unknown): ShopifyAnalyticsArgs {
  const result = ShopifyAnalyticsArgsSchema.safeParse(input);
  assert.equal(result.success, true);
  if (!result.success) throw result.error;
  return result.data;
}

describe('Shopify report compiler', () => {
  it('compiles the summary golden query exactly', () => {
    assert.equal(
      compileShopifyReport(parse({
        connectionId,
        operation: 'sales_summary',
        metrics: ['total_sales'],
        period: lastMonth,
      })),
      'FROM sales\nSHOW total_sales\nDURING last_month',
    );
  });

  it('compiles the timeseries golden query exactly', () => {
    assert.equal(
      compileShopifyReport(parse({
        connectionId,
        operation: 'sales_timeseries',
        metrics: ['total_sales', 'orders'],
        granularity: 'day',
        period: { kind: 'range', since: '-30d', until: 'today' },
      })),
      'FROM sales\nSHOW total_sales, orders\nTIMESERIES day\nSINCE -30d\nUNTIL today',
    );
  });

  it('compiles the sales-by-channel query using the approved referring_channel dimension', () => {
    assert.equal(
      compileShopifyReport(parse({
        connectionId,
        operation: 'sales_by_channel',
        metrics: ['total_sales', 'orders', 'total_sales'],
        dimension: 'referring_channel',
        period: lastMonth,
        limit: 25,
      })),
      'FROM sales\nSHOW total_sales, orders\nGROUP BY referring_channel\nDURING last_month\nORDER BY total_sales DESC\nLIMIT 25',
    );
  });

  it('compiles attribution and UTM golden queries with bounded dimensions', () => {
    assert.equal(
      compileShopifyReport(parse({
        connectionId,
        operation: 'sales_attribution',
        metric: 'total_sales',
        dimension: 'referring_channel',
        attribution: 'LAST_CLICK_ATTRIBUTION',
        period: lastMonth,
        limit: 10,
      })),
      'FROM sales\nSHOW total_sales\nGROUP BY referring_channel\nWITH LAST_CLICK_ATTRIBUTION\nDURING last_month\nORDER BY total_sales__last_click DESC\nLIMIT 10',
    );

    assert.equal(
      compileShopifyReport(parse({
        connectionId,
        operation: 'sales_by_utm',
        metrics: ['total_sales', 'orders'],
        dimensions: ['order_utm_source', 'order_utm_medium', 'order_utm_source'],
        period: lastMonth,
        limit: 50,
      })),
      'FROM sales\nSHOW total_sales, orders\nGROUP BY order_utm_source, order_utm_medium\nDURING last_month\nORDER BY total_sales DESC\nLIMIT 50',
    );
  });

  it('compiles product, customer, inventory, and payment datasets from closed schemas', () => {
    assert.equal(compileShopifyReport(parse({
      connectionId, operation: 'product_performance', metrics: ['net_sales', 'orders'],
      dimensions: ['product_title'], period: lastMonth, limit: 25,
    })), 'FROM sales\nSHOW net_sales, orders\nGROUP BY product_title\nDURING last_month\nORDER BY net_sales DESC\nLIMIT 25');
    assert.equal(compileShopifyReport(parse({
      connectionId, operation: 'customer_acquisition', metrics: ['new_customer_records', 'percent_of_customers'],
      granularity: 'month', period: lastMonth,
    })), 'FROM customers\nSHOW new_customer_records, percent_of_customers\nTIMESERIES month\nDURING last_month');
    assert.equal(compileShopifyReport(parse({
      connectionId, operation: 'inventory_position', metrics: ['ending_inventory_units_at_location', 'inventory_units_net_change_at_location'],
      dimensions: ['inventory_location_name', 'product_variant_id'], period: { kind: 'range', since: '-30d', until: 'today' }, limit: 100,
    })), 'FROM inventory_by_location\nSHOW ending_inventory_units_at_location, inventory_units_net_change_at_location\nGROUP BY inventory_location_name, product_variant_id\nSINCE -30d\nUNTIL today\nORDER BY ending_inventory_units_at_location DESC\nLIMIT 100');
    assert.equal(compileShopifyReport(parse({
      connectionId, operation: 'payments_by_method', metrics: ['net_payments', 'transactions'],
      dimensions: ['payment_method'], period: lastMonth, limit: 50,
    })), 'FROM payments\nSHOW net_payments, transactions\nGROUP BY payment_method\nDURING last_month\nORDER BY net_payments DESC\nLIMIT 50');
  });

  it('rejects raw ShopifyQL, arbitrary dimensions, and query-injection strings', () => {
    const rejected = [
      { connectionId, operation: 'sales_summary', metrics: ['total_sales'], period: lastMonth, query: 'DROP TABLE sales' },
      { connectionId, operation: 'sales_by_channel', metrics: ['total_sales'], dimension: 'marketing_channel', period: lastMonth, limit: 25 },
      { connectionId, operation: 'sales_by_channel', metrics: ['total_sales'], dimension: 'referring_channel\nDROP TABLE sales', period: lastMonth, limit: 25 },
      { connectionId, operation: 'sales_summary', metrics: ['total_sales'], period: { kind: 'preset', value: 'last_month; DROP TABLE sales' } },
      { connectionId, operation: 'sales_by_utm', metrics: ['total_sales'], dimensions: ['order_utm_source', 'custom_dimension'], period: lastMonth, limit: 50 },
      { connectionId, operation: 'sales_summary', metrics: ['total_sales'], period: { kind: 'range', since: '-9999d', until: 'today' } },
      { connectionId, operation: 'sales_summary', metrics: ['total_sales'], period: { kind: 'range', since: '2026-08-01', until: '2026-07-01' } },
      { connectionId, operation: 'sales_timeseries', metrics: ['orders'], granularity: 'day', period: { kind: 'range', since: '-500d', until: 'today' } },
      { connectionId, operation: 'sales_summary', metrics: ['orders'], period: { kind: 'range', since: '2026-02-31', until: 'today' } },
      { connectionId, operation: 'sales_summary', metrics: ['orders'], period: { kind: 'range', since: '2025-02-29', until: 'today' } },
      { connectionId, operation: 'sales_summary', metrics: ['orders'], period: { kind: 'range', since: '2026-01-01', until: '2026-04-31' } },
      { connectionId, operation: 'product_performance', metrics: ['net_payments'], dimensions: ['product_title'], period: lastMonth, limit: 25 },
      { connectionId, operation: 'inventory_position', metrics: ['ending_inventory_units_at_location'], dimensions: ['customer_email'], period: lastMonth, limit: 25 },
      { connectionId, operation: 'payments_by_method', metrics: ['net_payments'], dimensions: ['payment_card_bin'], period: lastMonth, limit: 25 },
    ];

    for (const input of rejected) {
      assert.equal(ShopifyAnalyticsArgsSchema.safeParse(input).success, false, JSON.stringify(input));
    }
  });

  it('accepts leap-day calendar ranges', () => {
    assert.equal(ShopifyAnalyticsArgsSchema.safeParse({
      connectionId,
      operation: 'sales_summary',
      metrics: ['orders'],
      period: { kind: 'range', since: '2024-02-29', until: '2024-03-01' },
    }).success, true);
  });
});
