/**
 * The four figures the profile claims about somebody.
 *
 * A streak, a peak day and a longest task are each a shape across days rather
 * than a sum of them, so no endpoint reports them and nothing else checks them.
 * They are also the most quotable numbers on the page — "29 days" is the sort
 * of thing a person repeats — which makes being quietly wrong worse here than
 * on a chart, where a reader can see the days for themselves.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  byMonth, currentStreak, longestStreak, peakDay, spanLabel,
  type UsagePoint,
} from './use-my-activity'

/** A day of the series. Runs and tokens vary independently, as they do live. */
const day = (date: string, runs: number, tokens = runs * 1000): UsagePoint =>
  ({ date, runs, spendUsd: tokens / 1_000_000, tokensIn: tokens, tokensOut: 0 })

describe('longestStreak', () => {
  it('finds the longest unbroken stretch, not the last one', () => {
    const series = [
      day('2026-08-01', 2), day('2026-08-02', 1), day('2026-08-03', 4),
      day('2026-08-04', 0),
      day('2026-08-05', 1), day('2026-08-06', 1),
    ]
    assert.equal(longestStreak(series), 3)
  })

  it('counts a day that ran something but recorded no tokens', () => {
    // The case this is deliberately not measured on spend: a refused run, or one
    // that failed before its first model call, writes no token row. Measured on
    // spend the middle day is a gap and the streak reads 1 instead of 3.
    const series = [day('2026-08-01', 1), { ...day('2026-08-02', 3, 0), spendUsd: 0 }, day('2026-08-03', 1)]
    assert.equal(longestStreak(series), 3)
  })

  it('is zero for somebody who has never run anything', () => {
    assert.equal(longestStreak([day('2026-08-01', 0), day('2026-08-02', 0)]), 0)
  })
})

describe('currentStreak', () => {
  it('survives a quiet today, because the day is not over', () => {
    const series = [day('2026-08-01', 1), day('2026-08-02', 2), day('2026-08-03', 0)]
    assert.equal(currentStreak(series), 2)
  })

  it('ends at a gap earlier than today', () => {
    const series = [day('2026-08-01', 3), day('2026-08-02', 0), day('2026-08-03', 1)]
    assert.equal(currentStreak(series), 1)
  })

  it('forgives only the final day', () => {
    // Two silent days at the end is a broken streak, not a day in progress.
    const series = [day('2026-08-01', 3), day('2026-08-02', 0), day('2026-08-03', 0)]
    assert.equal(currentStreak(series), 0)
  })
})

describe('peakDay', () => {
  it('picks the heaviest day by tokens rather than by tasks', () => {
    // One long research task moves more than a dozen one-line questions, and it
    // is the tokens tile this feeds.
    const series = [day('2026-08-01', 12, 4_000), day('2026-08-02', 1, 90_000)]
    assert.equal(peakDay(series)?.date, '2026-08-02')
  })

  it('is null for an empty window rather than a day of zeroes', () => {
    assert.equal(peakDay([]), null)
  })
})

describe('byMonth', () => {
  it('keeps a month with nothing in it', () => {
    // A gap in somebody's history is a fact. Dropping the month makes the
    // switcher's arrows skip over time without telling anyone.
    const series = [day('2026-06-30', 1), day('2026-07-15', 0), day('2026-08-02', 3)]
    assert.deepEqual(byMonth(series).map(m => m.key), ['2026-06', '2026-07', '2026-08'])
  })

  it('puts every day of a month in that month, oldest month first', () => {
    const months = byMonth([day('2026-08-02', 1), day('2026-07-30', 1), day('2026-07-31', 1)])
    assert.deepEqual(months.map(m => m.key), ['2026-07', '2026-08'])
    assert.equal(months[0]!.days.length, 2)
  })

  it('labels a month as itself, not the one before it', () => {
    // `new Date('2026-08')` is parsed as UTC midnight, which is July in every
    // timezone west of Greenwich.
    assert.match(byMonth([day('2026-08-02', 1)])[0]!.label, /August/)
  })
})

describe('spanLabel', () => {
  it('reads a long task in hours and minutes', () => {
    assert.equal(spanLabel(46_440_000), '12h 54m')
  })

  it('reads a real Divo run in minutes and seconds', () => {
    assert.equal(spanLabel(3_457_189), '57m 37s')
  })

  it('reads a short one in seconds', () => {
    assert.equal(spanLabel(8_200), '8s')
  })

  it('says nothing rather than "0s" when no run has finished', () => {
    assert.equal(spanLabel(0), '—')
  })
})
