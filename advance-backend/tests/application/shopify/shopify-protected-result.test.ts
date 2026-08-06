import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyShopifyProtectedResult } from '../../../src/application/shopify/shopify-protected-result';

describe('Shopify protected result classification', () => {
  it('marks an empty protected lookup and binds its requested subject', () => {
    assert.deepEqual(classifyShopifyProtectedResult({
      toolId: 'shopifyCustomers',
      args: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        operation: 'get_customer',
        customerId: 'gid://shopify/Customer/42',
      },
      result: { status: 'empty', data: null },
    }), {
      used: true,
      provider: 'shopify',
      connectionId: '11111111-1111-4111-8111-111111111111',
      category: 'customers',
      references: [{
        provider: 'shopify',
        connectionId: '11111111-1111-4111-8111-111111111111',
        resourceType: 'customer',
        resourceId: 'gid://shopify/Customer/42',
      }],
    });
  });

  it('marks aggregate and no-match operations even when no exact reference exists', () => {
    const classified = classifyShopifyProtectedResult({
      toolId: 'shopifyCustomers',
      args: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        operation: 'count_customers',
      },
      result: { status: 'complete', data: { count: 12 } },
    });
    assert.equal(classified?.used, true);
    assert.deepEqual(classified?.references, []);
  });

  it('collects only exact matching Shopify resource types and ignores analytics', () => {
    const classified = classifyShopifyProtectedResult({
      toolId: 'shopifyOrders',
      args: { connectionId: '11111111-1111-4111-8111-111111111111', operation: 'list_orders' },
      result: {
        data: [
          { id: 'gid://shopify/Order/7' },
          { id: 'gid://shopify/Customer/9' },
          { id: 'not-a-shopify-id' },
        ],
      },
    });
    assert.deepEqual(classified?.references.map(reference => reference.resourceId), [
      'gid://shopify/Order/7',
    ]);
    assert.equal(classifyShopifyProtectedResult({
      toolId: 'shopifyAnalytics',
      args: { connectionId: '11111111-1111-4111-8111-111111111111' },
      result: { rows: [] },
    }), undefined);
  });

  it('collects references from list results that include preview and data', () => {
    const classified = classifyShopifyProtectedResult({
      toolId: 'shopifyOrders',
      args: { connectionId: '11111111-1111-4111-8111-111111111111', operation: 'list_orders' },
      result: {
        data: [{ id: 'gid://shopify/Order/7' }],
        preview: {
          rows: [{ 'Shopify order ID': 'gid://shopify/Order/7' }],
        },
      },
    });
    assert.deepEqual(classified?.references.map(reference => reference.resourceId), [
      'gid://shopify/Order/7',
    ]);
  });

  it('covers a full 100-row page and explicitly marks larger payloads truncated', () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    const fullPage = classifyShopifyProtectedResult({
      toolId: 'shopifyCustomers',
      args: { connectionId, operation: 'list_customers' },
      result: { data: Array.from({ length: 100 }, (_, index) => ({ id: `gid://shopify/Customer/${index + 1}` })) },
    });
    assert.equal(fullPage?.references.length, 100);
    assert.equal(fullPage?.referencesTruncated, undefined);

    const oversized = classifyShopifyProtectedResult({
      toolId: 'shopifyCustomers',
      args: { connectionId, operation: 'list_customers' },
      result: { data: Array.from({ length: 101 }, (_, index) => ({ id: `gid://shopify/Customer/${index + 1}` })) },
    });
    assert.equal(oversized?.references.length, 100);
    assert.equal(oversized?.referencesTruncated, true);
  });
});
