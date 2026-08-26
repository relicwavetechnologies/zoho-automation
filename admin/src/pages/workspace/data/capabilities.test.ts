import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasCapability, holds } from './capabilities'

test('holds: null means show everything', () => {
  assert.equal(holds(null, 'followUps', 'send'), true)
  assert.equal(holds(null, 'mail', 'read'), true)
  assert.equal(hasCapability(null, 'mail'), true)
  assert.equal(hasCapability(null, 'followUps'), true)
})

test('holds: empty array hides', () => {
  assert.equal(holds({ mail: [], followUps: [] }, 'mail', 'read'), false)
  assert.equal(holds({ mail: [], followUps: [] }, 'followUps', 'send'), false)
  assert.equal(hasCapability({ mail: [] }, 'mail'), false)
  assert.equal(hasCapability({ followUps: [] }, 'followUps'), false)
})

test('holds: checks action inclusion', () => {
  assert.equal(holds({ followUps: ['read', 'send'] }, 'followUps', 'send'), true)
  assert.equal(holds({ followUps: ['read'] }, 'followUps', 'send'), false)
  assert.equal(holds({ mail: ['read'] }, 'mail', 'read'), true)
  assert.equal(holds({ mail: ['read'] }, 'mail', 'send'), false)
})

test('a capability the server did not report on is shown, not hidden', () => {
  // An absent key is "no answer", the same as null — not "no access". A gated
  // surface added to the shell before the server learns to report on it would
  // otherwise vanish for everybody who holds it, with nothing on screen to
  // discover, because the whole failure is an absence.
  assert.equal(holds({}, 'followUps', 'send'), true)
  assert.equal(holds({ mail: ['read'] }, 'followUps', 'read'), true)
  assert.equal(hasCapability({}, 'mail'), true)
})

test('an empty array is a refusal, and is not confused with an absent key', () => {
  assert.equal(hasCapability({ mail: [] }, 'mail'), false)
  assert.equal(hasCapability({ mail: [] }, 'followUps'), true)
})

test('hasCapability: non-empty means offered', () => {
  assert.equal(hasCapability({ mail: ['read'] }, 'mail'), true)
  assert.equal(hasCapability({ followUps: ['read', 'update', 'send'] }, 'followUps'), true)
})

test('holds does not treat null as empty', () => {
  // The null rule must not be spread: null is "could not determine", empty is "no access".
  // If null were treated as empty, a transient permission failure would hide tabs
  // somebody actually holds.
  assert.equal(holds(null, 'mail', 'read'), true)
  assert.equal(hasCapability(null, 'mail'), true)
})
