import { describe, expect, it } from 'vitest'

import { timeAgoFromSeconds } from '../time-ago'

const NOW_MS = 1_700_000_000_000
const nowSeconds = NOW_MS / 1000
const secondsAgo = (n: number) => nowSeconds - n

describe('timeAgoFromSeconds', () => {
  it('reads thread timestamps as seconds, not milliseconds', () => {
    // Thread `updated` is Date.now() / 1000. Handing it a millisecond value is
    // the likely mistake, and it must not quietly format as a valid age.
    expect(timeAgoFromSeconds(secondsAgo(86_400), NOW_MS)).toBe('1 day ago')
    expect(timeAgoFromSeconds(NOW_MS, NOW_MS)).toBe('just now')
  })

  it('formats each bucket with correct pluralisation', () => {
    expect(timeAgoFromSeconds(secondsAgo(5), NOW_MS)).toBe('just now')
    expect(timeAgoFromSeconds(secondsAgo(60), NOW_MS)).toBe('1 minute ago')
    expect(timeAgoFromSeconds(secondsAgo(120), NOW_MS)).toBe('2 minutes ago')
    expect(timeAgoFromSeconds(secondsAgo(3_600), NOW_MS)).toBe('1 hour ago')
    expect(timeAgoFromSeconds(secondsAgo(7_200), NOW_MS)).toBe('2 hours ago')
    expect(timeAgoFromSeconds(secondsAgo(86_400), NOW_MS)).toBe('1 day ago')
    expect(timeAgoFromSeconds(secondsAgo(604_800), NOW_MS)).toBe('1 week ago')
    expect(timeAgoFromSeconds(secondsAgo(2_592_000), NOW_MS)).toBe('1 month ago')
    expect(timeAgoFromSeconds(secondsAgo(31_536_000), NOW_MS)).toBe('1 year ago')
  })

  it('returns an empty string rather than "NaN ago" for unusable input', () => {
    expect(timeAgoFromSeconds(undefined, NOW_MS)).toBe('')
    expect(timeAgoFromSeconds(null, NOW_MS)).toBe('')
    expect(timeAgoFromSeconds(Number.NaN, NOW_MS)).toBe('')
    expect(timeAgoFromSeconds(0, NOW_MS)).toBe('')
  })

  it('treats a future timestamp as the present instead of going negative', () => {
    expect(timeAgoFromSeconds(nowSeconds + 5_000, NOW_MS)).toBe('just now')
  })
})
