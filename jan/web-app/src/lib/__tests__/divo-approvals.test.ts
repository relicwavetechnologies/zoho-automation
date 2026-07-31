import { describe, expect, it } from 'vitest'

import { expiryLabel, isUrgent, type ApprovalItem } from '../divo-approvals'

const NOW = Date.parse('2026-07-26T12:00:00Z')
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe('expiryLabel', () => {
  it('counts minutes under an hour', () => {
    expect(expiryLabel(at(8 * 60_000), NOW)).toBe('Expires in 8 min')
  })

  it('counts hours up to a day, singular at one', () => {
    expect(expiryLabel(at(2 * 3_600_000), NOW)).toBe('Expires in 2 hours')
    expect(expiryLabel(at(3_600_000), NOW)).toBe('Expires in 1 hour')
  })

  it('counts days beyond that', () => {
    expect(expiryLabel(at(48 * 3_600_000), NOW)).toBe('Expires in 2 days')
  })

  it('says so plainly once the deadline has passed', () => {
    expect(expiryLabel(at(-1), NOW)).toBe('Expired')
  })

  it('shows nothing rather than a guess when there is no deadline', () => {
    expect(expiryLabel(null, NOW)).toBeNull()
    expect(expiryLabel('not a date', NOW)).toBeNull()
  })
})

describe('isUrgent', () => {
  const item = (expiresAt: string | null) => ({ expiresAt } as ApprovalItem)

  it('is urgent within the last hour', () => {
    expect(isUrgent(item(at(59 * 60_000)), NOW)).toBe(true)
  })

  it('is not urgent beyond an hour', () => {
    expect(isUrgent(item(at(61 * 60_000)), NOW)).toBe(false)
  })

  // An expired request is not urgent — it is over, and colouring it as
  // actionable would ask for a decision that can no longer land.
  it('is not urgent once expired', () => {
    expect(isUrgent(item(at(-1000)), NOW)).toBe(false)
  })

  it('is not urgent without a deadline', () => {
    expect(isUrgent(item(null), NOW)).toBe(false)
  })
})
