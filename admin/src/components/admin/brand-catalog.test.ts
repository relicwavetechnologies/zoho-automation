import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLogoDevUrl } from './brand-catalog'

test('builds a cacheable domain logo URL with the shared rendering policy', () => {
  const value = buildLogoDevUrl('shopify', 'pk_example123', 24)
  assert.ok(value)
  const url = new URL(value)
  assert.equal(url.origin, 'https://img.logo.dev')
  assert.equal(url.pathname, '/shopify.com')
  assert.equal(url.searchParams.get('size'), '24')
  assert.equal(url.searchParams.get('format'), 'png')
  assert.equal(url.searchParams.get('retina'), 'true')
  assert.equal(url.searchParams.get('fallback'), '404')
})

test('uses encoded name lookup for product-specific marks', () => {
  const value = buildLogoDevUrl('googleSheets', 'pk_example123', 16)
  assert.ok(value)
  const url = new URL(value)
  assert.equal(url.pathname, '/name/Google%20Sheets')
  assert.equal(url.searchParams.get('size'), '16')
})

test('refuses a missing or non-publishable token', () => {
  assert.equal(buildLogoDevUrl('gmail', '', 16), null)
  assert.equal(buildLogoDevUrl('gmail', 'sk_secret', 16), null)
})
