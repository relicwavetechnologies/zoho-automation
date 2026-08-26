import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  filterScopeNumbers,
  openCountsByNumber,
  scopePillLabel,
  scopeRow,
  scopeMenuRows,
} from './scope-selector'
import type { FollowUp, LinkedNumber } from './use-follow-ups'

const numbers: LinkedNumber[] = [
  { id: 'n1', label: 'Priya Nair', phoneE164: '+919845011223', status: 'linked', lastSeenAt: new Date().toISOString(), stale: false, darkSince: null },
  { id: 'n2', label: 'Rohit Sharma', phoneE164: '+919845033445', status: 'linked', lastSeenAt: new Date().toISOString(), stale: false, darkSince: null },
  { id: 'n3', label: 'Vendor Desk', phoneE164: '+919845099001', status: 'linked', lastSeenAt: new Date().toISOString(), stale: false, darkSince: null },
  { id: 'n4', label: 'Sales Line 1', phoneE164: '+919845022334', status: 'linked', lastSeenAt: new Date().toISOString(), stale: true, darkSince: null },
  { id: 'n5', label: 'Kavya Reddy', phoneE164: '+919845066778', status: 'disconnected', lastSeenAt: new Date().toISOString(), stale: false, darkSince: new Date().toISOString() },
]

const followUps = [
  { id: 'f1', title: 'Send menu', detail: '', kind: 'commitment', ownerLabel: 'We owe', owner: 'us', counterparty: 'A', dueDate: null, urgency: 'high', chatId: 'c1', chatName: 'X', remindAt: null, updatedAt: new Date().toISOString(), sessionId: 'n1' },
  { id: 'f2', title: 'Chase quote', detail: '', kind: 'request', ownerLabel: 'We owe', owner: 'us', counterparty: 'B', dueDate: null, urgency: 'medium', chatId: 'c2', chatName: 'Y', remindAt: null, updatedAt: new Date().toISOString(), sessionId: 'n1' },
  { id: 'f3', title: 'Confirm count', detail: '', kind: 'request', ownerLabel: 'We owe', owner: 'us', counterparty: 'C', dueDate: null, urgency: 'low', chatId: 'c3', chatName: 'Z', remindAt: null, updatedAt: new Date().toISOString(), sessionId: 'n2' },
] as unknown as FollowUp[]

describe('scopePillLabel', () => {
  it('reads All N numbers when unscoped', () => {
    assert.equal(scopePillLabel(undefined, numbers), 'All 5 numbers')
    assert.equal(scopePillLabel(undefined, []), 'All 0 numbers')
  })
  it('reads the number label when scoped', () => {
    assert.equal(scopePillLabel('n2', numbers), 'Rohit Sharma')
  })
  it('falls back to All N when the id names no number', () => {
    assert.equal(scopePillLabel('ghost', numbers), 'All 5 numbers')
  })
})

describe('filterScopeNumbers', () => {
  it('returns everything on empty query', () => {
    assert.equal(filterScopeNumbers(numbers, '').length, 5)
    assert.equal(filterScopeNumbers(numbers, '   ').length, 5)
  })
  it('filters by label case-insensitively', () => {
    const out = filterScopeNumbers(numbers, 'rohit')
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'n2')
  })
  it('filters by phone', () => {
    const out = filterScopeNumbers(numbers, '9845011223')
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'n1')
  })
  it('matches label or phone', () => {
    const out = filterScopeNumbers(numbers, 'Vendor')
    assert.equal(out.length, 1)
    assert.equal(out[0]!.label, 'Vendor Desk')
  })
})

describe('openCountsByNumber', () => {
  it('counts per number from sessionId', () => {
    const map = openCountsByNumber(followUps)
    assert.equal(map.get('n1'), 2)
    assert.equal(map.get('n2'), 1)
    assert.equal(map.get('n3'), undefined)
  })
  it('ignores follow-ups with no sessionId', () => {
    const mixed = [...followUps, { id: 'f4', sessionId: undefined } as any]
    const map = openCountsByNumber(mixed as any)
    assert.equal(map.get('n1'), 2)
  })
})

describe('scopeRow', () => {
  it('builds health dot, state label and count', () => {
    const row = scopeRow(numbers[0]!, 2)
    assert.equal(row.label, 'Priya Nair')
    assert.equal(row.phone, '+919845011223')
    assert.equal(row.healthDot, 'ok')
    assert.equal(row.stateLabel, 'Reading')
    assert.equal(row.count, 2)
  })
  it('marks a dark number correctly', () => {
    const row = scopeRow(numbers[4]!, 0)
    assert.equal(row.healthDot, 'err')
    assert.equal(row.stateLabel, 'Not connected')
  })
  it('marks a quiet number', () => {
    const row = scopeRow(numbers[3]!, 5)
    assert.equal(row.healthDot, 'warn')
    assert.equal(row.stateLabel, 'No messages lately')
  })
})

describe('scopeMenuRows', () => {
  it('filters and counts, sorted by label', () => {
    const rows = scopeMenuRows(numbers, followUps, '')
    assert.equal(rows.length, 5)
    // sorted by label: Kavya, Priya, Rohit, Sales, Vendor
    assert.equal(rows[0]!.label, 'Kavya Reddy')
    assert.equal(rows[1]!.label, 'Priya Nair')
    assert.equal(rows[1]!.count, 2)
    assert.equal(rows[2]!.count, 1) // Rohit
  })
  it('respects the search query', () => {
    const rows = scopeMenuRows(numbers, followUps, 'sales')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.label, 'Sales Line 1')
  })
})
