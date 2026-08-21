import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteBrandLogoUrl } from './brand-source'

test('uses the bundled asset instead of replacing it with a remote logo', () => {
  assert.equal(remoteBrandLogoUrl('shopify', 'pk_example123', 32, 'asset'), null)
})

test('uses the bundled component instead of replacing it with a remote logo', () => {
  assert.equal(remoteBrandLogoUrl('gmail', 'pk_example123', 32, 'component'), null)
})

test('builds a remote logo only when no local mark exists', () => {
  const value = remoteBrandLogoUrl('shopify', 'pk_example123', 32, null)
  assert.ok(value)
  assert.equal(new URL(value).pathname, '/shopify.com')
})
