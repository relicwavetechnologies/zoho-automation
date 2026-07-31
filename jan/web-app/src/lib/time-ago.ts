/**
 * Relative-time formatting for thread timestamps.
 *
 * Thread `updated` is written as `Date.now() / 1000` (see `useThreads`), so it
 * is in SECONDS, not milliseconds. Passing a millisecond value here reads as a
 * date ~50,000 years out and formats as "just now".
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

const plural = (value: number, unit: string) =>
  `${value} ${unit}${value === 1 ? '' : 's'} ago`

/**
 * Formats a seconds-since-epoch timestamp as e.g. "just now", "5 minutes ago",
 * "1 day ago". Returns an empty string for missing or non-finite input so
 * callers can render nothing rather than "NaN ago".
 */
export function timeAgoFromSeconds(
  seconds: number | undefined | null,
  now: number = Date.now()
): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return ''

  const elapsed = Math.floor(now / 1000 - seconds)
  // Clock skew or a future timestamp reads as the present rather than negative.
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour')
  if (elapsed < WEEK) return plural(Math.floor(elapsed / DAY), 'day')
  if (elapsed < MONTH) return plural(Math.floor(elapsed / WEEK), 'week')
  if (elapsed < YEAR) return plural(Math.floor(elapsed / MONTH), 'month')
  return plural(Math.floor(elapsed / YEAR), 'year')
}
