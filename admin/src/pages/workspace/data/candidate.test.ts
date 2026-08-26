import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidateBlock, candidateKey, candidateLabel, type Candidate } from './use-team'

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  isWorkspaceMember: true,
  isAlreadyAssigned: false,
  ...over,
})

test('a Lark candidate is keyed by its identity', () => {
  assert.equal(candidateKey(candidate({ channelIdentityId: 'ci_1', userId: 'u1' })), 'ci_1')
})

test('an invited member with no Lark identity still gets a distinct key', () => {
  // The case this exists for: two people invited by email, neither on this
  // company's Lark install. Keyed on channelIdentityId alone both were
  // `undefined`, and React reused one row's selection for the other.
  const a = candidateKey(candidate({ userId: 'u1', email: 'vibhore@urbanaura.in' }))
  const b = candidateKey(candidate({ userId: 'u2', email: 'other@urbanaura.in' }))
  assert.equal(a, 'user:u1')
  assert.notEqual(a, b)
})

test('a Lark account with no Divo user behind it falls back to email', () => {
  assert.equal(candidateKey(candidate({ email: 'nobody@example.com' })), 'email:nobody@example.com')
})

test('only somebody with a Divo account and no membership here can be added', () => {
  assert.equal(candidateBlock(candidate({ userId: 'u1' })), null)
  assert.equal(candidateBlock(candidate({ userId: 'u1', isAlreadyAssigned: true })), 'Already in this team')
  assert.equal(candidateBlock(candidate({ isWorkspaceMember: false })), 'No Divo account yet')
  // A Lark identity Divo has seen but nobody has claimed.
  assert.equal(candidateBlock(candidate({ userId: undefined })), 'No Divo account yet')
})

test('the label never assumes Lark', () => {
  assert.equal(candidateLabel(candidate({ name: 'Vibhore Bhargava' })), 'Vibhore Bhargava')
  assert.equal(candidateLabel(candidate({ larkDisplayName: 'Vibhore' })), 'Vibhore')
  assert.equal(candidateLabel(candidate({ email: 'v@urbanaura.in' })), 'v@urbanaura.in')
  // Nameless and emailless. It used to read "Unnamed Lark account", which sent
  // somebody looking in a directory this person was never in.
  assert.equal(candidateLabel(candidate()), 'Unnamed account')
})
