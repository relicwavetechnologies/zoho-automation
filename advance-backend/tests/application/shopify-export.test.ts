import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  flattenShopifyAnalyticsRows,
  previewCoverageForAnalytics,
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
});
