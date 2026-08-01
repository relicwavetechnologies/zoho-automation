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

/** Day (YYYY-MM-DD) → cost, priced per model before being summed. */
export function costByDay(rows: DailyModelRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    const c = costUsd(r.model, { cacheMissIn: Number(r.miss), cacheHitIn: Number(r.hit), output: Number(r.out) });
    m.set(key, (m.get(key) ?? 0) + c);
  }
  return m;
}

export const startOfToday = (): Date => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/**
 * A dense series with zeroes for quiet days.
 *
 * A chart drawn straight from grouped rows silently omits days with no usage,
 * which compresses the x-axis and makes an occasional user look continuously
 * busy. Every day in the window gets a point.
 */
export function fillSeries(byDay: Map<string, number>, days: number): { date: string; spendUsd: number }[] {
  const out: { date: string; spendUsd: number }[] = [];
  const today = startOfToday();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: key, spendUsd: byDay.get(key) ?? 0 });
  }
  return out;
}
