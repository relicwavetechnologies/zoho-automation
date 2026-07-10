/**
 * Model pricing — legit per-model cost from cache-split token counts (Track B).
 *
 * Cost = cacheMissIn·missRate + cacheHitIn·hitRate + output·outRate, per model.
 * This is the single source of truth for cost across the observability panel;
 * every spend aggregation prices from exact token counts here rather than the
 * provider-reported `reportedCostUsd` (which we only cross-check against).
 *
 * Rates are USD per 1,000,000 tokens. DeepSeek official pricing, verified
 * 2026-07 (V4 Pro's launch promo ended 2026-05-31, so regular rates apply):
 *   https://api-docs.deepseek.com/quick_start/pricing
 * When DeepSeek changes prices or a new model appears, edit RATES only.
 */

export interface ModelRate {
  cacheHitIn: number
  cacheMissIn: number
  output: number
}

const RATES: Record<string, ModelRate> = {
  'deepseek-v4-flash': { cacheHitIn: 0.0028, cacheMissIn: 0.14, output: 0.28 },
  'deepseek-v4-pro': { cacheHitIn: 0.0145, cacheMissIn: 1.74, output: 3.48 },
}

/** Fallback rate for unknown models — the cheap flash tier (never over-bills). */
const DEFAULT_RATE: ModelRate = RATES['deepseek-v4-flash']!

/** The two models the proxy offers. Anything else canonicalizes to one of these. */
export const PROXY_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const
export type ProxyModel = (typeof PROXY_MODELS)[number]

/**
 * Canonicalize a provider/model id to one of our two priced models. DeepSeek
 * aliases `deepseek-chat`→flash and `deepseek-reasoner`→pro, and clients may send
 * short/versioned ids; we normalize so allow-list checks AND pricing are exact.
 */
const MODEL_ALIASES: Record<string, ProxyModel> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}

export function canonicalModel(raw: string | undefined | null): ProxyModel {
  if (!raw) return 'deepseek-v4-flash'
  const key = raw.trim().toLowerCase()
  const alias = MODEL_ALIASES[key]
  if (alias) return alias
  // Heuristic for unseen ids: anything hinting at the pro/reasoner tier → pro.
  if (key.includes('pro') || key.includes('reason')) return 'deepseek-v4-pro'
  return 'deepseek-v4-flash'
}

export function rateFor(modelId: string): ModelRate {
  return RATES[modelId] ?? DEFAULT_RATE
}

export interface SplitTokens {
  cacheMissIn: number
  cacheHitIn: number
  output: number
}

/** USD cost for one model's token split. */
export function costUsd(modelId: string, t: SplitTokens): number {
  const r = rateFor(modelId)
  return (t.cacheMissIn * r.cacheMissIn + t.cacheHitIn * r.cacheHitIn + t.output * r.output) / 1_000_000
}
