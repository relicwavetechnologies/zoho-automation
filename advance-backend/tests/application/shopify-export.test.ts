import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  flattenShopifyAnalyticsRows,
  flattenShopifyCustomerRows,
  flattenShopifyOrderRows,
  previewCoverageForAnalytics,
  previewCoverageForShopifyList,
  shopifyArgsFingerprint,
  shopifyExportTitle,
} from '../../src/application/shopify/shopify-export.ts';

describe('shopify export helpers', () => {
  it('flattens analytics rows using display names', () => {
    const rows = flattenShopifyAnalyticsRows(
      [{ name: 'total_sales', dataType: 'MONEY', displayName: 'Total sales' }],
      [{ total_sales: '123.45' }],
    );
    assert.deepEqual(rows, [{ 'Total sales': '123.45' }]);
  });

  it('builds stable fingerprints for equivalent args', () => {
    const left = shopifyArgsFingerprint({
      connectionId: '11111111-1111-4111-8111-111111111111',
      operation: 'product_performance',
      period: { kind: 'preset', value: 'last_30_days' },
      metrics: ['net_sales', 'orders'],
      dimensions: ['product_title'],
      limit: 25,
    });
    const right = shopifyArgsFingerprint({
      connectionId: '11111111-1111-4111-8111-111111111111',
      operation: 'product_performance',
      metrics: ['net_sales', 'orders'],
      dimensions: ['product_title'],
      limit: 25,
      period: { kind: 'preset', value: 'last_30_days' },
    });
    assert.equal(left, right);
    assert.match(left, /^[a-f0-9]{64}$/);
  });

  it('marks ranked analytics below schema max as provider limited', () => {
    const coverage = previewCoverageForAnalytics({
      connectionId: '11111111-1111-4111-8111-111111111111',
      operation: 'product_performance',
      period: { kind: 'preset', value: 'last_30_days' },
      metrics: ['net_sales'],
      dimensions: ['product_title'],
      limit: 10,
    }, 10);
    assert.equal(coverage.kind, 'provider_limited');
  });

  it('marks series analytics as complete', () => {
    const coverage = previewCoverageForAnalytics({
      connectionId: '11111111-1111-4111-8111-111111111111',
      operation: 'sales_timeseries',
      period: { kind: 'preset', value: 'last_30_days' },
      metrics: ['total_sales'],
      granularity: 'day',
    }, 30);
    assert.deepEqual(coverage, { kind: 'complete', totalRows: 30 });
  });

  it('builds bounded export titles', () => {
    const title = shopifyExportTitle(
      'shopifyAnalytics',
      {
        connectionId: '11111111-1111-4111-8111-111111111111',
        operation: 'product_performance',
        period: { kind: 'preset', value: 'last_30_days' },
        metrics: ['net_sales'],
        dimensions: ['product_title'],
        limit: 25,
      },
      'demo.myshopify.com',
    );
    assert.match(title, /Shopify product performance — demo\.myshopify\.com/);
    assert.ok(title.length <= 120);
  });

  it('flattens order list nodes into stable export columns', () => {
    const rows = flattenShopifyOrderRows([{
      id: 'gid://shopify/Order/1',
      name: '#1001',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      sourceName: 'web',
      currentTotalPriceSet: { shopMoney: { amount: '99.00', currencyCode: 'USD' } },
    }]);
    assert.deepEqual(rows, [{
      Order: '#1001',
      'Created at': '2026-08-01T00:00:00Z',
      'Updated at': '2026-08-02T00:00:00Z',
      'Financial status': 'PAID',
      'Fulfillment status': 'FULFILLED',
      Source: 'web',
      'Total amount': '99.00',
      Currency: 'USD',
      'Shopify order ID': 'gid://shopify/Order/1',
    }]);
  });

  it('flattens customer list nodes without contact fields', () => {
    const rows = flattenShopifyCustomerRows([{
      id: 'gid://shopify/Customer/1',
      state: 'ENABLED',
      tags: ['vip', 'wholesale'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
      amountSpent: { amount: '500.00', currencyCode: 'USD' },
    }]);
    assert.deepEqual(rows, [{
      'Customer ID': 'gid://shopify/Customer/1',
      State: 'ENABLED',
      Tags: 'vip, wholesale',
      'Created at': '2026-01-01T00:00:00Z',
      'Updated at': '2026-08-01T00:00:00Z',
      'Amount spent': '500.00',
      Currency: 'USD',
    }]);
  });

  it('ignores pagination fields in list fingerprints', () => {
    const left = shopifyArgsFingerprint({
      connectionId: '11111111-1111-4111-8111-111111111111',
      operation: 'list_orders',
      first: 25,
      after: 'cursor-a',
    });
    const right = shopifyArgsFingerprint({
      connectionId: '11111111-1111-4111-8111-111111111111',
      operation: 'list_orders',
      first: 100,
      after: 'cursor-b',
    });
    assert.equal(left, right);
  });

  it('marks paginated Shopify lists as truncated when more pages exist', () => {
    const coverage = previewCoverageForShopifyList(true, 25);
    assert.equal(coverage.kind, 'truncated');
  });
});
