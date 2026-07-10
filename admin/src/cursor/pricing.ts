/**
 * Model pricing (frontend mirror of advance-backend/src/application/observability/pricing.ts).
 * Used only to price the run-detail trace client-side (reconstructed from the
 * event stream, which carries per-turn cache-split tokens). Keep RATES in sync
 * with the backend — both are DeepSeek official, verified 2026-07.
 */

export interface ModelRate {
  cacheHitIn: number
  cacheMissIn: number
  output: number
}

const RATES: Record<string, ModelRate> = {
  "deepseek-v4-flash": { cacheHitIn: 0.0028, cacheMissIn: 0.14, output: 0.28 },
  "deepseek-v4-pro": { cacheHitIn: 0.0145, cacheMissIn: 1.74, output: 3.48 },
}
const DEFAULT_RATE: ModelRate = RATES["deepseek-v4-flash"]!

/** USD cost per 1M tokens applied to one model's cache-split token counts. */
export function costUsd(modelId: string, t: { cacheMissIn: number; cacheHitIn: number; output: number }): number {
  const r = RATES[modelId] ?? DEFAULT_RATE
  return (t.cacheMissIn * r.cacheMissIn + t.cacheHitIn * r.cacheHitIn + t.output * r.output) / 1_000_000
}
