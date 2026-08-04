import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isShopifyGraphqlId, normalizeShopDomain } from '../../../src/domain/shopify/shopify-shop';

describe('Shopify shop and GraphQL ID validation', () => {
  it('normalizes only canonical myshopify hosts', () => {
    assert.equal(normalizeShopDomain(' Acme-Store '), 'acme-store.myshopify.com');
    assert.equal(normalizeShopDomain('ACME-STORE.MYSHOPIFY.COM'), 'acme-store.myshopify.com');
    assert.equal(normalizeShopDomain('acme-store.myshopify.com'), 'acme-store.myshopify.com');
  });

  it('rejects URLs, paths, ports, empty labels, and non-Shopify hosts', () => {
    for (const value of [
      '',
      '   ',
      'https://acme-store.myshopify.com',
      'acme-store.myshopify.com/admin',
      'acme-store.myshopify.com:443',
      'acme_store',
      '-acme-store',
      'acme-store-',
      'acme.store',
      'acme-store.myshopify.com.evil.example',
      'acme-store.myshopify.com.evil',
    ]) {
      assert.equal(normalizeShopDomain(value), null, value);
    }
  });

  it('accepts only positive decimal Shopify Order and Customer GIDs', () => {
    assert.equal(isShopifyGraphqlId('gid://shopify/Order/1', 'Order'), true);
    assert.equal(isShopifyGraphqlId('gid://shopify/Customer/987654', 'Customer'), true);

    for (const [value, resource] of [
      ['gid://shopify/Order/0', 'Order'],
      ['gid://shopify/Order/-1', 'Order'],
      ['gid://shopify/Order/1.5', 'Order'],
      ['gid://shopify/Customer/1', 'Order'],
      ['gid://shopify/Product/1', 'Customer'],
      ['gid://shopify/Customer/abc', 'Customer'],
      ['gid://shopify/Customer/01', 'Customer'],
      ['gid://shopify/Customer/1/extra', 'Customer'],
      ['1', 'Customer'],
    ] as const) {
      assert.equal(isShopifyGraphqlId(value, resource), false, `${resource}: ${value}`);
    }
  });
});
