/**
 * What a day of usage adds up to, and what a quiet day looks like.
 *
 * These two helpers feed every usage figure a member or an admin ever sees, and
 * the profile page now reads four separate facts off the same series — cost,
 * tokens through, tasks, and the gaps between them. A day that goes missing or
 * lands on the wrong date is not a rendering bug there; it is a wrong number
 * next to somebody's name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillSeries, totalsByDay, type DailyModelRow } from '../../src/application/observability/token-cost';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const row = (date: string, model: string, miss: number, hit: number, out: number): DailyModelRow =>
  ({ day: day(date), model, miss, hit, out });

test('a day folds its models together and keeps cost and tokens apart', () => {
  const totals = totalsByDay([
    row('2026-08-01', 'deepseek-v4-flash', 1_000, 4_000, 200),
    row('2026-08-01', 'deepseek-v4-pro', 500, 0, 100),
  ]);

  const first = totals.get('2026-08-01');
  assert.ok(first);
  // Input is miss + hit: a cache hit is still input the model read, it is only
  // priced lower. Summing misses alone under-reports throughput by the whole
  // cached prefix, which on a long conversation is most of it.
  assert.equal(first.tokensIn, 5_500);
  assert.equal(first.tokensOut, 300);
  // Two models priced separately then added, never one blended rate.
  assert.ok(first.spendUsd > 0);
});

test('cost is priced per model, so a cheap model cannot be billed at a dear one’s rate', () => {
  const cheap = totalsByDay([row('2026-08-01', 'deepseek-v4-flash', 1_000_000, 0, 0)]).get('2026-08-01');
  const dear = totalsByDay([row('2026-08-01', 'deepseek-v4-pro', 1_000_000, 0, 0)]).get('2026-08-01');
  assert.ok(cheap && dear);
  assert.ok(dear.spendUsd > cheap.spendUsd);
});

test('a cache hit costs less than the same tokens missed', () => {
  const missed = totalsByDay([row('2026-08-01', 'deepseek-v4-flash', 1_000_000, 0, 0)]).get('2026-08-01');
  const cached = totalsByDay([row('2026-08-01', 'deepseek-v4-flash', 0, 1_000_000, 0)]).get('2026-08-01');
  assert.ok(missed && cached);
  assert.ok(cached.spendUsd < missed.spendUsd);
  // Same throughput either way — that is the point of reporting them apart.
  assert.equal(cached.tokensIn, missed.tokensIn);
});

test('every day in the window gets a point, including the silent ones', () => {
  const series = fillSeries(new Map(), 7);
  assert.equal(series.length, 7);
  assert.ok(series.every(p => p.spendUsd === 0 && p.tokensIn === 0 && p.tokensOut === 0 && p.runs === 0));
  // Oldest first, ending today. The charts and the heatmap both read it in this
  // direction, and reversed it draws a person's history backwards.
  const dates = series.map(p => p.date);
  assert.deepEqual(dates, [...dates].sort());
});

test('a day that spent nothing can still have run something', () => {
  // The real case this exists for: a refused run, or one that failed before its
  // first model call, writes no token row at all. Drawn from spend alone that
  // day is blank, and the person is told they did not use Divo on a day they did.
  const series = fillSeries(new Map(), 3, new Map([[dateOffset(1), 4]]));
  const yesterday = series.find(p => p.date === dateOffset(1));
  assert.ok(yesterday);
  assert.equal(yesterday.runs, 4);
  assert.equal(yesterday.spendUsd, 0);
});

test('runs land on the day they happened, not one either side of it', () => {
  const today = dateOffset(0);
  const series = fillSeries(
    totalsByDay([row(today, 'deepseek-v4-flash', 100, 0, 10)]),
    2,
    new Map([[today, 9]]),
  );
  const last = series[series.length - 1];
  assert.ok(last);
  assert.equal(last.date, today);
  assert.equal(last.runs, 9);
  assert.ok(last.tokensIn > 0);
});

/** N days back from today, as the UTC date key the series is built on. */
function dateOffset(back: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}
