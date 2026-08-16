/**
 * Turning recorded token counts into money, in one place.
 *
 * These helpers were private to the admin spend router. A member can now see
 * their own usage, and two implementations of the same arithmetic would drift —
 * at which point a member's total and the admin's figure for that same member
 * disagree, and neither is obviously the wrong one. So they live here and both
 * routers call them.
 *
 * Cost is computed from the cache split, never from the provider's reported
 * figure: cache-hit input is priced far below cache-miss, and treating them
 * alike overstates spend by a large multiple on a long conversation.
 */
import { costUsd } from './pricing';

export type TokenSum = {
  actualInputTokens: number | null;
  cacheReadInputTokens: number | null;
  actualOutputTokens: number | null;
};

/** Cost of one (model, summed tokens) pair. */
export const priceSum = (modelId: string, s: TokenSum | undefined): number =>
  costUsd(modelId, {
    cacheMissIn: s?.actualInputTokens ?? 0,
    cacheHitIn: s?.cacheReadInputTokens ?? 0,
    output: s?.actualOutputTokens ?? 0,
  });

export type DailyModelRow = { day: Date; model: string; miss: number; hit: number; out: number };

/** What one day of usage came to, once its per-model rows are folded together. */
export type DailyTotals = { spendUsd: number; tokensIn: number; tokensOut: number };

/**
 * Day (YYYY-MM-DD) → what that day cost and what it spent, priced per model
 * before being summed.
 *
 * The token counts ride along because they are already in the rows this reads.
 * They used to be dropped here and the cost kept, so every caller that wanted
 * "tokens per day" — a trend line, a peak-day figure — had no way to ask for it
 * except a second query over the same table returning the same numbers.
 */
export function totalsByDay(rows: DailyModelRow[]): Map<string, DailyTotals> {
  const m = new Map<string, DailyTotals>();
  for (const r of rows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    const miss = Number(r.miss);
    const hit = Number(r.hit);
    const out = Number(r.out);
    const day = m.get(key) ?? { spendUsd: 0, tokensIn: 0, tokensOut: 0 };
    day.spendUsd += costUsd(r.model, { cacheMissIn: miss, cacheHitIn: hit, output: out });
    // Cache hits are input the model still read, so they count towards what the
    // day put through — they are merely priced far below a miss.
    day.tokensIn += miss + hit;
    day.tokensOut += out;
    m.set(key, day);
  }
  return m;
}

export const startOfToday = (): Date => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/**
 * A spend series as bar heights, 0–100.
 *
 * Zero stays zero. The version this replaced floored every bar at 6 and
 * returned a flat 6 for a window with no spend at all, so a member who had run
 * nothing got fourteen full-height bars beneath a card reading "$0.00" and
 * "0 tasks" — the endpoint reporting activity that never happened, on the one
 * screen an admin opens to find out whether it did.
 *
 * Keeping an empty bar visible is a drawing problem, and the stylesheet already
 * solves it: `.ws-spark i` carries a 2px minimum. A floor in the data cannot be
 * told apart from a real small day.
 */
export function sparklineHeights(series: readonly number[]): number[] {
  const max = Math.max(...series, 0);
  if (max <= 0) return series.map(() => 0);
  return series.map((v) => Math.round((v / max) * 100));
}

/** One day of the window, whether or not anything happened on it. */
export type UsagePoint = DailyTotals & { date: string; runs: number };

/**
 * A dense series with zeroes for quiet days.
 *
 * A chart drawn straight from grouped rows silently omits days with no usage,
 * which compresses the x-axis and makes an occasional user look continuously
 * busy. Every day in the window gets a point.
 *
 * Runs are counted from a different table than tokens and so arrive as their
 * own map. A caller that does not care passes nothing and every day reports
 * zero runs — which is not a lie about the data, only about what was asked for,
 * and the two callers in that position never read the field.
 */
export function fillSeries(
  byDay: Map<string, DailyTotals>,
  days: number,
  runsByDay: Map<string, number> = new Map(),
): UsagePoint[] {
  const out: UsagePoint[] = [];
  /*
   * UTC midnight, because that is the day `costByDay` keys by.
   *
   * This walked back from *local* midnight and then formatted with
   * `toISOString`, so on a server east of Greenwich every key came out as the
   * previous date — the whole series shifted a day against the map it reads
   * from. In IST the newest slot was yesterday and today's spend had nowhere to
   * go, so it was counted in the total and missing from the calendar under it.
   * The window and the days it draws now agree.
   */
  const today = startOfUtcDay();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const totals = byDay.get(key);
    out.push({
      date: key,
      spendUsd: totals?.spendUsd ?? 0,
      tokensIn: totals?.tokensIn ?? 0,
      tokensOut: totals?.tokensOut ?? 0,
      runs: runsByDay.get(key) ?? 0,
    });
  }
  return out;
}

/** Midnight UTC today — the boundary Postgres `date_trunc('day', …)` uses. */
export const startOfUtcDay = (): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** The first instant of a `days`-long window ending today, in the same UTC days. */
export const windowStart = (days: number): Date =>
  new Date(startOfUtcDay().getTime() - (days - 1) * 86_400_000);
