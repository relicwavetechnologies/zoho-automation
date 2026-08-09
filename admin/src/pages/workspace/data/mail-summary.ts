/**
 * What Divo did with this member's mail, counted.
 *
 * Kept out of the screen because these numbers are the screen's only claim. A
 * summary that disagrees with the feed underneath it is worse than no summary,
 * and a count computed inline in a component cannot be checked without a
 * browser and a signed-in account.
 */
import type { MailCaught } from './use-mail-automations'

export const MAIL_SUMMARY_WINDOW_DAYS = 30

/**
 * Rows in the Latest feed.
 *
 * Four, because the feed sits beside the summary card and four rows is what
 * squares the two heights. More rows made the pair uneven; the whole list is
 * one click away on Caught, which is what that page is for.
 */
export const MAIL_LATEST_ROWS = 4

/**
 * Rows to ask the caught feed for.
 *
 * The route validates `limit` at 100 and 400s above it, so asking for more
 * does not get more — it gets nothing, and the page renders "this could not be
 * read" every single load. Named here so the number the summary depends on and
 * the number the request sends cannot drift apart.
 */
export const MAIL_FEED_LIMIT = 100

/**
 * Passed on, held, failed, or still going.
 *
 * Held is not a failure and is never counted as one. A rule with an AI step
 * spends most of its life deciding *not* to forward, and folding those into an
 * error count would report a working rule as broken — which is the exact
 * confusion the Caught page exists to remove.
 *
 * Delivery wins over status. A rule that fails open forwards a message its AI
 * step could not read, and calling that "failed" would report a message sitting
 * in the destination inbox as one that never went.
 */
export type MailBucket = 'passed' | 'held' | 'failed' | 'pending'

export function mailBucketOf(row: Pick<MailCaught, 'status' | 'deliveredAt' | 'lastError'>): MailBucket {
  if (row.deliveredAt) return 'passed'
  const status = (row.status ?? '').toLowerCase()
  if (status === 'delivered' || status === 'sent') return 'passed'
  if (status === 'held' || status === 'skipped' || status === 'suppressed') return 'held'
  if (status === 'failed' || row.lastError) return 'failed'
  return 'pending'
}

/** Local calendar day. UTC would file a late-evening message under tomorrow. */
export function mailDayKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

export type MailSummary = {
  total: number
  counts: Record<MailBucket, number>
  /** One entry per day in the window, oldest first, zeroes included. */
  series: { date: string; value: number }[]
  busiestDay: { date: string; value: number } | null
  /** Days in the window that saw at least one message. */
  activeDays: number
  /** When the most recent message was caught, or null for a silent window. */
  lastCaughtAt: string | null
  /**
   * The feed hit its row cap inside this window, so the counts are a floor and
   * the earliest squares may be empty for want of data rather than of mail.
   *
   * Worth its own flag because truncation damages a calendar differently from
   * a total: a capped total can be reported as "at least N", but a capped
   * calendar draws real-looking zeroes on days it simply never heard about.
   */
  truncated: boolean
  latest: MailCaught[]
}

export function summarizeMail(
  caught: readonly MailCaught[],
  now: Date = new Date(),
  windowDays: number = MAIL_SUMMARY_WINDOW_DAYS,
): MailSummary {
  // From the first moment of the earliest day shown, not from "N × 24h ago" —
  // otherwise the oldest column in the heatmap is a part-day and reads as a
  // quiet day rather than a clipped one.
  const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  firstDay.setDate(firstDay.getDate() - (windowDays - 1))
  const recent = caught.filter((row) => new Date(row.firstAttemptAt).getTime() >= firstDay.getTime())

  // Seeded with every day so a quiet day is a zero rather than a gap. The
  // heatmap has to draw the silence to be worth reading.
  const perDay = new Map<string, number>()
  for (let i = 0; i < windowDays; i += 1) {
    const day = new Date(firstDay)
    day.setDate(firstDay.getDate() + i)
    perDay.set(mailDayKey(day), 0)
  }
  for (const row of recent) {
    const key = mailDayKey(new Date(row.firstAttemptAt))
    if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1)
  }

  const counts: Record<MailBucket, number> = { passed: 0, held: 0, failed: 0, pending: 0 }
  for (const row of recent) counts[mailBucketOf(row)] += 1

  const series = [...perDay].map(([date, value]) => ({ date, value }))
  const busiest = series.reduce<{ date: string; value: number } | null>(
    (best, day) => (best === null || day.value > best.value ? day : best),
    null,
  )

  const newestFirst = [...recent]
    .sort((a, b) => new Date(b.firstAttemptAt).getTime() - new Date(a.firstAttemptAt).getTime())

  return {
    total: recent.length,
    counts,
    series,
    busiestDay: busiest && busiest.value > 0 ? busiest : null,
    activeDays: series.filter((day) => day.value > 0).length,
    lastCaughtAt: newestFirst[0]?.firstAttemptAt ?? null,
    // The cap applies to the whole feed, not to the window. So a full feed only
    // hides something if it ran out *inside* the window: if the oldest row it
    // returned predates the window, everything in the window came back.
    truncated: caught.length >= MAIL_FEED_LIMIT
      && caught.every((row) => new Date(row.firstAttemptAt).getTime() >= firstDay.getTime()),
    latest: newestFirst.slice(0, MAIL_LATEST_ROWS),
  }
}
