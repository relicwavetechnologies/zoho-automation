/**
 * The Home page's only claim is its counts, so they are checked here rather
 * than by eye in a browser. Every case below is one where a plausible-looking
 * implementation reports a working setup as a broken one, or the reverse.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIL_FEED_LIMIT, MAIL_LATEST_ROWS, mailBucketOf, mailDayKey, summarizeMail,
} from './mail-summary'
import type { MailCaught } from './use-mail-automations'

const at = (iso: string, over: Partial<MailCaught> = {}): MailCaught => ({
  deliveryId: `d-${iso}-${over.status ?? 'x'}`,
  status: 'delivered',
  attempts: 1,
  ambiguous: false,
  lastError: null,
  subject: 'Subject',
  from: 'someone@example.com',
  firstAttemptAt: iso,
  deliveredAt: iso,
  nextAttemptAt: null,
  ruleId: 'r1',
  ruleName: 'Forward Abhishek to Anish',
  action: {},
  destination: {},
  verdict: null,
  ...over,
})

describe('mailBucketOf', () => {
  it('counts a delivered message as passed on', () => {
    assert.equal(mailBucketOf({ status: 'delivered', deliveredAt: '2026-08-09T10:00:00Z', lastError: null }), 'passed')
  })

  it('never counts a held message as a failure', () => {
    // A rule with an AI step spends most of its life declining to forward.
    // Counting that as an error reports a working rule as broken.
    for (const status of ['held', 'skipped', 'suppressed']) {
      assert.equal(mailBucketOf({ status, deliveredAt: null, lastError: null }), 'held')
    }
  })

  it('counts a real send failure as failed', () => {
    assert.equal(mailBucketOf({ status: 'failed', deliveredAt: null, lastError: null }), 'failed')
    assert.equal(mailBucketOf({ status: 'retrying', deliveredAt: null, lastError: 'SMTP 550' }), 'failed')
  })

  it('trusts delivery over status, because a fail-open rule still sent the mail', () => {
    // The message is in the destination inbox. Reporting it as failed would
    // send the member looking for something that already arrived.
    assert.equal(
      mailBucketOf({ status: 'failed', deliveredAt: '2026-08-09T10:00:00Z', lastError: 'judge unavailable' }),
      'passed',
    )
  })

  it('treats an unknown in-flight status as pending, not as failed', () => {
    assert.equal(mailBucketOf({ status: 'queued', deliveredAt: null, lastError: null }), 'pending')
  })
})

describe('mailDayKey', () => {
  it('files a late-evening message under its own local day', () => {
    // UTC would push 23:30 on the 9th into the 10th for anyone east of London,
    // which moves a message a day forward in the heatmap.
    assert.equal(mailDayKey(new Date(2026, 7, 9, 23, 30)), '2026-08-09')
    assert.equal(mailDayKey(new Date(2026, 7, 9, 0, 5)), '2026-08-09')
  })
})

describe('summarizeMail', () => {
  const now = new Date(2026, 7, 9, 12, 0) // 9 Aug 2026, midday, local
  const on = (day: number, hour = 9) => new Date(2026, 7, day, hour).toISOString()

  it('draws one column per day, including the silent ones', () => {
    const summary = summarizeMail([at(on(9))], now, 30)
    assert.equal(summary.series.length, 30)
    assert.equal(summary.series[summary.series.length - 1]!.date, '2026-08-09')
    assert.equal(summary.series[0]!.date, '2026-07-11')
    // 29 zeroes and one 1 — the silence is the point of the chart.
    assert.equal(summary.series.filter((d) => d.value === 0).length, 29)
  })

  it('counts each bucket separately and never folds held into failed', () => {
    const summary = summarizeMail([
      at(on(9)),
      at(on(9), { status: 'held', deliveredAt: null }),
      at(on(8), { status: 'held', deliveredAt: null }),
      at(on(8), { status: 'failed', deliveredAt: null, lastError: 'SMTP 550' }),
    ], now, 30)

    assert.equal(summary.total, 4)
    assert.deepEqual(summary.counts, { passed: 1, held: 2, failed: 1, pending: 0 })
  })

  it('excludes anything older than the window without dropping it from the feed', () => {
    const summary = summarizeMail([at(on(9)), at(new Date(2026, 5, 1).toISOString())], now, 30)
    assert.equal(summary.total, 1)
    assert.equal(summary.series.reduce((s, d) => s + d.value, 0), 1)
  })

  it('keeps the whole of the oldest day rather than clipping it to the hour', () => {
    // A "30 × 24h ago" cutoff would drop this and leave the first column
    // reading as a quiet day when it is really a half-drawn one.
    const oldestMorning = new Date(2026, 6, 11, 1).toISOString()
    const summary = summarizeMail([at(oldestMorning)], now, 30)
    assert.equal(summary.total, 1)
    assert.equal(summary.series[0]!.value, 1)
  })

  it('names the busiest day, and says nothing when there is no traffic', () => {
    const summary = summarizeMail([at(on(7)), at(on(7), { status: 'held', deliveredAt: null }), at(on(9))], now, 30)
    assert.deepEqual(summary.busiestDay, { date: '2026-08-07', value: 2 })
    assert.equal(summarizeMail([], now, 30).busiestDay, null)
  })

  it('reports when mail was last caught, from the newest row not the first', () => {
    // The feed does not arrive sorted, so taking caught[0] would report
    // whichever row the API happened to return first as "last caught".
    const summary = summarizeMail([at(on(5)), at(on(9, 16)), at(on(7))], now, 30)
    assert.equal(summary.lastCaughtAt, on(9, 16))
    assert.equal(summarizeMail([], now, 30).lastCaughtAt, null)
  })

  it('counts days that saw mail, not messages', () => {
    // Two on one day and one on another is two active days, not three.
    const summary = summarizeMail([at(on(7)), at(on(7), { status: 'held', deliveredAt: null }), at(on(9))], now, 30)
    assert.equal(summary.activeDays, 2)
    assert.equal(summarizeMail([], now, 30).activeDays, 0)
  })

  it('orders the latest newest-first regardless of how the feed arrived', () => {
    const summary = summarizeMail([at(on(5)), at(on(9)), at(on(7))], now, 30)
    assert.deepEqual(
      summary.latest.map((r) => r.firstAttemptAt.slice(0, 10)),
      ['2026-08-09', '2026-08-07', '2026-08-05'],
    )
  })

  it('caps the feed at the row count the layout is built around', () => {
    const many = Array.from({ length: 12 }, (_, i) => at(on(9, 8 + i)))
    const summary = summarizeMail(many, now, 30)
    assert.equal(summary.latest.length, MAIL_LATEST_ROWS)
    // Capped for layout, but the counts still see every message.
    assert.equal(summary.total, 12)
  })

  it('never asks the route for more rows than it accepts', () => {
    // The route validates limit at 100 and 400s above it, so an over-ask does
    // not return more — it returns nothing, and the page reads as broken.
    assert.ok(MAIL_FEED_LIMIT <= 100, 'the caught route rejects a limit above 100')
  })

  it('flags a window whose feed ran out inside it', () => {
    // A full feed that never reaches past the window start means there could be
    // more in the window that never came back.
    const full = Array.from({ length: MAIL_FEED_LIMIT }, (_, i) => at(on(9, 8 + (i % 12))))
    assert.equal(summarizeMail(full, now, 30).truncated, true)
  })

  it('does not flag a full feed that reaches past the window', () => {
    // The oldest row predates the window, so everything inside it came back —
    // the cap bit outside the range this card describes.
    const full = [
      ...Array.from({ length: MAIL_FEED_LIMIT - 1 }, (_, i) => at(on(9, 8 + (i % 12)))),
      at(new Date(2026, 5, 1).toISOString()),
    ]
    assert.equal(summarizeMail(full, now, 30).truncated, false)
  })

  it('does not flag a feed that came back under the cap', () => {
    assert.equal(summarizeMail([at(on(9))], now, 30).truncated, false)
    assert.equal(summarizeMail([], now, 30).truncated, false)
  })

  it('reports zeroes for an empty feed rather than throwing', () => {
    const summary = summarizeMail([], now, 30)
    assert.equal(summary.total, 0)
    assert.deepEqual(summary.counts, { passed: 0, held: 0, failed: 0, pending: 0 })
    assert.equal(summary.series.length, 30)
    assert.equal(summary.latest.length, 0)
  })

  it('bucket counts always add up to the total', () => {
    const summary = summarizeMail([
      at(on(9)), at(on(9), { status: 'held', deliveredAt: null }),
      at(on(8), { status: 'failed', deliveredAt: null }), at(on(8), { status: 'queued', deliveredAt: null }),
    ], now, 30)
    const { passed, held, failed, pending } = summary.counts
    assert.equal(passed + held + failed + pending, summary.total)
  })
})
