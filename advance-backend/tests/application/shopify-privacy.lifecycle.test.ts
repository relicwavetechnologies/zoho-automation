import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  boundedPrivacyLimit,
  hashProtectedIdentifier,
  parseShopifyPrivacyExport,
  prepareRedactionSelectors,
  prepareShopifyPrivacyRequest,
  ShopifyPrivacyValidationError,
} from '../../src/application/shopify/shopify-privacy.lifecycle';

const deadlineAt = new Date('2026-09-01T00:00:00.000Z');
const expiresAt = new Date('2026-10-01T00:00:00.000Z');

describe('Shopify privacy lifecycle contract', () => {
  it('normalizes exact identifiers and serializes a bounded ready export', () => {
    const prepared = prepareShopifyPrivacyRequest({
      companyId: ' company-1 ',
      shopDomain: 'DEMO',
      requestId: ' request-1 ',
      customerId: ' gid://shopify/Customer/1 ',
      orderIds: ['gid://shopify/Order/2', 'gid://shopify/Order/1', 'gid://shopify/Order/2'],
      state: 'ready',
      exportPayload: { customer: { email: 'private@example.test' } },
      deadlineAt,
      expiresAt,
    });

    assert.equal(prepared.companyId, 'company-1');
    assert.equal(prepared.shopDomain, 'demo.myshopify.com');
    assert.equal(prepared.requestId, 'request-1');
    assert.equal(prepared.customerIdHash, hashProtectedIdentifier('gid://shopify/Customer/1'));
    assert.deepEqual(prepared.orderIdHashes, [
      hashProtectedIdentifier('gid://shopify/Order/1'),
      hashProtectedIdentifier('gid://shopify/Order/2'),
    ]);
    assert.equal(JSON.stringify(prepared).includes('gid://shopify/Customer/1'), false);
    assert.equal(JSON.stringify(prepared).includes('gid://shopify/Order/1'), false);
    assert.deepEqual(parseShopifyPrivacyExport(prepared.serializedExport!), {
      customer: { email: 'private@example.test' },
    });
  });

  it('supports received and failed initial states without an export payload', () => {
    const received = prepareShopifyPrivacyRequest({
      companyId: 'company-1',
      shopDomain: 'demo.myshopify.com',
      requestId: 'request-1',
      customerId: 'customer-1',
      orderIds: [],
      state: 'received',
      deadlineAt,
      expiresAt,
    });
    const failed = prepareShopifyPrivacyRequest({
      companyId: 'company-1',
      shopDomain: 'demo.myshopify.com',
      requestId: 'request-2',
      orderIds: ['order-1'],
      state: 'failed',
      failureCode: 'export.upstream_unavailable',
      deadlineAt,
      expiresAt,
    });

    assert.equal(received.serializedExport, null);
    assert.equal(failed.serializedExport, null);
    assert.equal(failed.failureCode, 'export.upstream_unavailable');
  });

  it('rejects missing subjects, unsafe failure codes, invalid retention, and oversized exports', () => {
    const base = {
      companyId: 'company-1',
      shopDomain: 'demo.myshopify.com',
      requestId: 'request-1',
      orderIds: [] as string[],
      deadlineAt,
      expiresAt,
    };
    assert.throws(() => prepareShopifyPrivacyRequest({ ...base, state: 'received' }), ShopifyPrivacyValidationError);
    assert.throws(() => prepareShopifyPrivacyRequest({
      ...base,
      customerId: 'customer-1',
      state: 'failed',
      failureCode: 'contains customer@example.test',
    }), ShopifyPrivacyValidationError);
    assert.throws(() => prepareShopifyPrivacyRequest({
      ...base,
      customerId: 'customer-1',
      state: 'received',
      deadlineAt: expiresAt,
      expiresAt: deadlineAt,
    }), ShopifyPrivacyValidationError);
    assert.throws(() => prepareShopifyPrivacyRequest({
      ...base,
      customerId: 'customer-1',
      state: 'ready',
      exportPayload: { value: 'x'.repeat(1_048_577) },
    }), ShopifyPrivacyValidationError);
    assert.throws(() => prepareShopifyPrivacyRequest({
      ...base,
      customerId: 'customer-1',
      state: 'ready',
      exportPayload: { missing: undefined },
    }), ShopifyPrivacyValidationError);
  });

  it('requires exact redaction selectors and clamps every batch to 100', () => {
    assert.throws(() => prepareRedactionSelectors({}), ShopifyPrivacyValidationError);
    assert.deepEqual(prepareRedactionSelectors({
      customerId: 'customer-1',
      orderIds: ['order-2', 'order-1', 'order-2'],
    }), {
      requestId: null,
      customerIdHash: hashProtectedIdentifier('customer-1'),
      orderIdHashes: [hashProtectedIdentifier('order-1'), hashProtectedIdentifier('order-2')],
    });
    assert.equal(boundedPrivacyLimit(undefined), 100);
    assert.equal(boundedPrivacyLimit(500), 100);
    assert.throws(() => boundedPrivacyLimit(0), ShopifyPrivacyValidationError);
  });
});
