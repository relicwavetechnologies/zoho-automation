/**
 * Model pricing (frontend mirror of advance-backend/src/application/observability/pricing.ts).
 * Used only to price the run-detail trace client-side (reconstructed from the
 * event stream, which carries per-turn cache-split tokens). Keep RATES in sync
 * with the backend — rates are provider-specific and verified 2026-07.
 */

export interface ModelRate {
  cacheHitIn: number
  cacheMissIn: number
  output: number
}

const RATES: Record<string, ModelRate> = {
  "muse-spark-1.2-contributor": { cacheHitIn: 0.002, cacheMissIn: 0.1, output: 0.2 },
  "muse-spark-1.2": { cacheHitIn: 0.15, cacheMissIn: 1.25, output: 4.25 },
  "deepseek-v4-flash": { cacheHitIn: 0.0028, cacheMissIn: 0.14, output: 0.28 },
  "deepseek-v4-pro": { cacheHitIn: 0.0145, cacheMissIn: 1.74, output: 3.48 },
  "gpt-5.6-luna": { cacheHitIn: 0.02, cacheMissIn: 0.2, output: 1.2 },
}
/* A model absent from this table is priced as the platform default rather than
   at zero: showing a run as free is a worse lie than showing it at the wrong
   rate, and the backend's figure — not this one — is what anybody is billed. */
const DEFAULT_RATE: ModelRate = RATES["muse-spark-1.2-contributor"]!

/** USD cost per 1M tokens applied to one model's cache-split token counts. */
export function costUsd(modelId: string, t: { cacheMissIn: number; cacheHitIn: number; output: number }): number {
  const r = RATES[modelId] ?? DEFAULT_RATE
  return (t.cacheMissIn * r.cacheMissIn + t.cacheHitIn * r.cacheHitIn + t.output * r.output) / 1_000_000
}
