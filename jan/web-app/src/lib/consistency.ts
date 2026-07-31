/**
 * Consistency heatmap: a GitHub-style contribution grid over recent activity.
 *
 * Two correctness rules drive this module:
 *
 * 1. **Local calendar days, not fixed 24h blocks.** A "day" is midnight to
 *    midnight in the viewer's timezone. Day arithmetic goes through `Date`
 *    rather than adding 86_400_000ms, because DST transitions make some local
 *    days 23 or 25 hours long — millisecond stepping drifts across them and
 *    silently misaligns the grid twice a year.
 *
 * 2. **Timestamps are seconds.** Thread `created` / `updated` are written as
 *    `Date.now() / 1000` (see `useThreads`), so callers pass seconds and this
 *    module converts. See also `timeAgoFromSeconds`.
 */

export const DAYS_PER_WEEK = 7
/** 16 columns against 7 rows keeps the grid a wide rectangle at a fixed cell size. */
export const DEFAULT_WEEKS = 16

export type ConsistencyLevel = 0 | 1 | 2 | 3 | 4

export type ConsistencyDay = {
  /** Local midnight for this day, in ms. */
  ms: number
  /** Number of distinct threads active on this day. */
  count: number
  level: ConsistencyLevel
  /** False for trailing cells after today — they pad the final week. */
  isFuture: boolean
}

export type Consistency = {
  /** `weeks * 7` cells, oldest first, ordered so a 7-row column grid reads as weeks. */
  days: ConsistencyDay[]
  weeks: number
  /** Consecutive active days ending today (or yesterday — see below). */
  currentStreak: number
  /** Longest run of consecutive active days inside the window. */
  longestStreak: number
  /** Total days with any activity in the window. */
  activeDays: number
}

/** Local midnight for the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** DST-safe day arithmetic — never add 86_400_000ms to cross a day boundary. */
export function addLocalDays(ms: number, days: number): number {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Local midnight of the Sunday that starts the week containing `ms`. */
export function startOfLocalWeek(ms: number): number {
  const day = new Date(ms).getDay()
  return addLocalDays(ms, -day)
}

/**
 * Activity buckets are intentionally coarse. Thread rows only carry `created`
 * and `updated`, so a day counts as active if a thread was started or last
 * touched on it — not a full per-message log. Counts are small in practice, so
 * fixed thresholds read better than quantiles over a sparse set.
 */
function levelFor(count: number): ConsistencyLevel {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count === 2) return 2
  if (count <= 4) return 3
  return 4
}

/**
 * Builds the grid.
 *
 * @param activitySeconds Timestamps in SECONDS. Duplicates on the same day are
 *   counted separately — pass one entry per thread-day you want to count.
 * @param now Reference "today" in ms.
 * @param weeks Number of week columns.
 */
export function buildConsistency(
  activitySeconds: number[],
  now: number,
  weeks: number = DEFAULT_WEEKS
): Consistency {
  const today = startOfLocalDay(now)
  // The final column is the week containing today, so the grid always ends on
  // the current week rather than mid-column.
  const firstDay = addLocalDays(startOfLocalWeek(today), -(weeks - 1) * DAYS_PER_WEEK)

  const counts = new Map<number, number>()
  for (const seconds of activitySeconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    const day = startOfLocalDay(seconds * 1000)
    // Ignore anything outside the window, and anything dated in the future.
    if (day < firstDay || day > today) continue
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }

  const days: ConsistencyDay[] = []
  for (let index = 0; index < weeks * DAYS_PER_WEEK; index += 1) {
    const ms = addLocalDays(firstDay, index)
    const count = counts.get(ms) ?? 0
    days.push({ ms, count, level: levelFor(count), isFuture: ms > today })
  }

  // Streaks only consider real days, never the trailing pad.
  const past = days.filter((day) => !day.isFuture)

  let longestStreak = 0
  let run = 0
  for (const day of past) {
    run = day.count > 0 ? run + 1 : 0
    if (run > longestStreak) longestStreak = run
  }

  // Walk back from today. If today has no activity yet the streak is measured
  // to yesterday, so an unfinished day doesn't read as a broken streak.
  let currentStreak = 0
  let cursor = past.length - 1
  if (cursor >= 0 && past[cursor]!.count === 0) cursor -= 1
  while (cursor >= 0 && past[cursor]!.count > 0) {
    currentStreak += 1
    cursor -= 1
  }

  return {
    days,
    weeks,
    currentStreak,
    longestStreak,
    activeDays: past.filter((day) => day.count > 0).length,
  }
}

/**
 * Activity timestamps for a set of threads: the day it was started and the day
 * it was last touched. Same-day pairs collapse so a one-sitting thread counts
 * once rather than twice.
 */
export function threadActivitySeconds(
  threads: Array<{ created?: number; updated?: number }>
): number[] {
  const out: number[] = []
  for (const thread of threads) {
    const created = thread.created
    const updated = thread.updated
    const createdDay =
      typeof created === 'number' && created > 0
        ? startOfLocalDay(created * 1000)
        : null
    const updatedDay =
      typeof updated === 'number' && updated > 0
        ? startOfLocalDay(updated * 1000)
        : null

    if (createdDay !== null) out.push(created as number)
    if (updatedDay !== null && updatedDay !== createdDay) {
      out.push(updated as number)
    }
  }
  return out
}
