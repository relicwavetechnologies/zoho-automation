import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsAttention, numberState, sinceLabel, summarizeFollowUps,
} from './follow-up-summary'
import type { FollowUp, LinkedNumber } from './use-follow-ups'

const NOW = new Date('2026-08-25T10:00:00Z')

const item = (over: Partial<FollowUp> = {}): FollowUp => ({
  id: 'f-1', title: 'Send the invoice', detail: '', kind: 'commitment',
  ownerLabel: 'We owe', owner: 'us', counterparty: 'Priya',
  dueDate: null, urgency: 'medium', chatId: 'c-1', chatName: 'Venue',
  remindAt: null, updatedAt: NOW.toISOString(), ...over,
})

const number = (over: Partial<LinkedNumber> = {}): LinkedNumber => ({
  id: 's-1', label: 'Bookings desk', phoneE164: '+919876543210',
  status: 'linked', lastSeenAt: NOW.toISOString(), stale: false,
  darkSince: null, ...over,
})

describe('summarizeFollowUps', () => {
  it('splits what we owe from what we are waiting on', () => {
    const s = summarizeFollowUps([
      item(), item({ id: 'f-2', owner: 'them' }), item({ id: 'f-3', owner: 'them' }),
    ], NOW)
    assert.equal(s.total, 3)
    assert.equal(s.weOwe, 1)
    assert.equal(s.waiting, 2)
  })

  it('counts overdue only against a stated date', () => {
    const s = summarizeFollowUps([
      item({ dueDate: '2026-08-20' }),
      item({ id: 'f-2', dueDate: '2026-09-01' }),
      item({ id: 'f-3', dueDate: null }),
    ], NOW)
    assert.equal(s.overdue, 1)
  })

  it('counts high urgency', () => {
    assert.equal(summarizeFollowUps([item({ urgency: 'high' }), item({ id: 'f-2' })], NOW).high, 1)
  })
})

describe('numberState', () => {
  it('reports a healthy number as healthy', () => {
    assert.equal(numberState(number()), 'healthy')
  })

  it('distinguishes a number that came back but is still missing messages', () => {
    // The state that matters most. Collapsing it into "healthy" would hide the
    // exact hole the re-read button exists to close.
    assert.equal(
      numberState(number({ status: 'linked', darkSince: '2026-08-23T00:00:00Z' })),
      'gap',
    )
  })

  it('reports a disconnected number as dark, gap or not', () => {
    assert.equal(numberState(number({ status: 'disconnected' })), 'dark')
    assert.equal(
      numberState(number({ status: 'disconnected', darkSince: '2026-08-23T00:00:00Z' })),
      'dark',
    )
  })

  it('separates quiet from broken', () => {
    // A handset can be legitimately quiet. That is not a fault, and flagging it
    // as one is how an alarm gets ignored.
    assert.equal(numberState(number({ stale: true })), 'quiet')
  })

  it('reports a number still being linked as pending', () => {
    assert.equal(numberState(number({ status: 'pending' })), 'pending')
  })
})

describe('needsAttention', () => {
  it('is true for dark, gap and quiet, false for healthy and pending', () => {
    assert.equal(needsAttention(number({ status: 'disconnected' })), true)
    assert.equal(needsAttention(number({ darkSince: '2026-08-23T00:00:00Z' })), true)
    assert.equal(needsAttention(number({ stale: true })), true)
    assert.equal(needsAttention(number()), false)
    assert.equal(needsAttention(number({ status: 'pending' })), false)
  })
})

describe('sinceLabel', () => {
  it('reads in the unit a person would use', () => {
    assert.equal(sinceLabel('2026-08-25T09:30:00Z', NOW), '30m')
    assert.equal(sinceLabel('2026-08-25T04:00:00Z', NOW), '6h')
    assert.equal(sinceLabel('2026-08-22T10:00:00Z', NOW), '3d')
  })

  it('says never rather than inventing a duration', () => {
    assert.equal(sinceLabel(null, NOW), 'never')
  })

  it('does not report a future timestamp as a negative age', () => {
    assert.equal(sinceLabel('2026-08-26T10:00:00Z', NOW), 'just now')
  })
})
