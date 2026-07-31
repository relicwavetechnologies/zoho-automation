import { describe, expect, it } from 'vitest'
import { getThreadDeletionDestination } from '../thread-navigation'

describe('getThreadDeletionDestination', () => {
  const threads = [
    { id: 'older', updated: 10 },
    { id: 'active', updated: 30 },
    { id: 'newest', updated: 40 },
  ] as Thread[]

  it('does not navigate when a background thread is deleted', () => {
    expect(getThreadDeletionDestination(threads, 'older', 'active')).toBeUndefined()
  })

  it('keeps the user in chats when the open thread is deleted', () => {
    expect(getThreadDeletionDestination(threads, 'active', 'active')).toBe('newest')
  })

  it('falls back to Home only when no thread survives', () => {
    expect(
      getThreadDeletionDestination([{ id: 'only', updated: 1 }] as Thread[], 'only', 'only')
    ).toBeUndefined()
  })
})
