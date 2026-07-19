import { describe, expect, it } from 'vitest'

import {
  addLocalDays,
  buildConsistency,
  DAYS_PER_WEEK,
  DEFAULT_WEEKS,
  startOfLocalDay,
  startOfLocalWeek,
  threadActivitySeconds,
} from '../consistency'

/** A Wednesday, mid-afternoon local time. */
const NOW = new Date(2026, 6, 15, 14, 30).getTime()
const TODAY = startOfLocalDay(NOW)

/** Seconds timestamp for local noon `n` days before today. */
const daysAgoSeconds = (n: number) =>
  (addLocalDays(TODAY, -n) + 12 * 3600 * 1000) / 1000

describe('day arithmetic', () => {
  it('snaps to local midnight', () => {
    const noon = new Date(2026, 6, 15, 12, 0).getTime()
    expect(new Date(startOfLocalDay(noon)).getHours()).toBe(0)
    expect(new Date(startOfLocalDay(noon)).getDate()).toBe(15)
  })

  it('crosses DST boundaries without drifting', () => {
    // US DST springs forward on 2026-03-08; that local day is 23h long, so
    // millisecond stepping would land at 23:00 the previous day.
    const beforeDst = new Date(2026, 2, 7).getTime()
    for (let i = 0; i < 4; i += 1) {
      const stepped = addLocalDays(beforeDst, i)
      expect(new Date(stepped).getHours()).toBe(0)
      expect(new Date(stepped).getDate()).toBe(7 + i)
    }
  })

  it('starts weeks on Sunday', () => {
    // 2026-07-15 is a Wednesday; its week starts Sunday 2026-07-12.
    expect(new Date(startOfLocalWeek(TODAY)).getDay()).toBe(0)
    expect(new Date(startOfLocalWeek(TODAY)).getDate()).toBe(12)
  })
})

describe('buildConsistency grid', () => {
  it('emits a full 7-row grid ending on the current week', () => {
    const result = buildConsistency([], NOW)
    expect(result.days).toHaveLength(DEFAULT_WEEKS * DAYS_PER_WEEK)
    // First cell is a Sunday so a 7-row column layout reads as weeks.
    expect(new Date(result.days[0]!.ms).getDay()).toBe(0)
    // Last cell is the Saturday of the current week.
    expect(new Date(result.days.at(-1)!.ms).getDay()).toBe(6)
  })

  it('marks days after today as future padding, not empty activity', () => {
    const result = buildConsistency([], NOW)
    const future = result.days.filter((day) => day.isFuture)
    // Wednesday → Thursday, Friday, Saturday remain in the final column.
    expect(future).toHaveLength(3)
    expect(result.days.filter((d) => !d.isFuture).at(-1)!.ms).toBe(TODAY)
  })

  it('ignores activity outside the window and in the future', () => {
    const result = buildConsistency(
      [daysAgoSeconds(400), daysAgoSeconds(-5)],
      NOW
    )
    expect(result.activeDays).toBe(0)
    expect(result.days.every((day) => day.count === 0)).toBe(true)
  })

  it('buckets counts into levels', () => {
    const at = (n: number) =>
      buildConsistency(Array.from({ length: n }, () => daysAgoSeconds(1)), NOW)
        .days.find((d) => d.ms === addLocalDays(TODAY, -1))!.level
    expect(at(0)).toBe(0)
    expect(at(1)).toBe(1)
    expect(at(2)).toBe(2)
    expect(at(3)).toBe(3)
    expect(at(4)).toBe(3)
    expect(at(9)).toBe(4)
  })
})

describe('streaks', () => {
  it('counts consecutive days ending today', () => {
    const result = buildConsistency([0, 1, 2].map(daysAgoSeconds), NOW)
    expect(result.currentStreak).toBe(3)
  })

  it('measures to yesterday when today has no activity yet', () => {
    // An unfinished day must not read as a broken streak.
    const result = buildConsistency([1, 2, 3].map(daysAgoSeconds), NOW)
    expect(result.currentStreak).toBe(3)
  })

  it('breaks the current streak on a real gap', () => {
    // Active 2 and 3 days ago, nothing yesterday or today.
    const result = buildConsistency([2, 3].map(daysAgoSeconds), NOW)
    expect(result.currentStreak).toBe(0)
    expect(result.longestStreak).toBe(2)
  })

  it('finds the longest run even when it is not the current one', () => {
    const result = buildConsistency(
      [0, 1, 5, 6, 7, 8, 9].map(daysAgoSeconds),
      NOW
    )
    expect(result.currentStreak).toBe(2)
    expect(result.longestStreak).toBe(5)
  })

  it('does not let future padding extend a streak', () => {
    const result = buildConsistency([0].map(daysAgoSeconds), NOW)
    expect(result.currentStreak).toBe(1)
    expect(result.longestStreak).toBe(1)
  })

  it('counts repeat activity on one day as a single streak day', () => {
    const sameDay = [daysAgoSeconds(1), daysAgoSeconds(1), daysAgoSeconds(1)]
    const result = buildConsistency(sameDay, NOW)
    expect(result.currentStreak).toBe(1)
    expect(result.activeDays).toBe(1)
  })

  it('reports nothing for an empty history', () => {
    const result = buildConsistency([], NOW)
    expect(result.currentStreak).toBe(0)
    expect(result.longestStreak).toBe(0)
    expect(result.activeDays).toBe(0)
  })
})

describe('threadActivitySeconds', () => {
  it('counts the start day and the last-touched day', () => {
    const created = daysAgoSeconds(5)
    const updated = daysAgoSeconds(1)
    expect(threadActivitySeconds([{ created, updated }])).toEqual([
      created,
      updated,
    ])
  })

  it('collapses a thread started and finished on the same day', () => {
    // Otherwise a one-sitting thread would double-weight its day.
    const created = daysAgoSeconds(3)
    const updated = created + 600
    expect(threadActivitySeconds([{ created, updated }])).toEqual([created])
  })

  it('tolerates missing or zeroed timestamps', () => {
    expect(threadActivitySeconds([{}, { created: 0, updated: 0 }])).toEqual([])
  })
})
