/**
 * The models Divo offers, and what each one costs.
 *
 * Cost = cacheMissIn·missRate + cacheHitIn·hitRate + output·outRate, per model.
 * This is the single source of truth for cost across the observability panel;
 * every spend aggregation prices from exact token counts here rather than the
 * provider-reported `reportedCostUsd` (which we only cross-check against).
 *
 * It is also where the backend decides which models exist, who serves them, and
 * which of them can see an image — the admin allow-list, the proxy's upstream
 * routing, and the model a run is launched on all read this table.
 *
 * The container cannot import it, so `divo-pi/divo/runtime-models.mjs` holds the
 * same ids, providers, and vision flags on the far side of the wall. **Adding or
 * changing a model means editing both**; `model-catalogue.test.ts` fails if they
 * disagree, because the two failures drift produces are a granted model the
 * controller rejects with `invalid_model`, and a run told to look at a picture
 * with a model that cannot see.
 *
 * Rates are USD per 1,000,000 tokens.
 *   DeepSeek, verified 2026-07 (V4 Pro's launch promo ended 2026-05-31):
 *     https://api-docs.deepseek.com/quick_start/pricing
 *   OpenAI GPT-5.6 Luna, verified 2026-07-31 after the 2026-07-30 price cut:
 *     https://developers.openai.com/api/docs/models/gpt-5.6-luna
 */

export interface ModelRate {
  cacheHitIn: number
  cacheMissIn: number
  output: number
}

export type ModelProvider = 'deepseek' | 'openai'

/** Every model the proxy offers. Anything else canonicalizes to one of these. */
export const PROXY_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-luna'] as const
export type ProxyModel = (typeof PROXY_MODELS)[number]

export interface ProxyModelSpec {
  /** The id we bill, gate, trace, and call the provider by. */
  readonly id: ProxyModel
  readonly provider: ModelProvider
  /** Shown in the admin grant. */
  readonly label: string
  /**
   * Whether the model can read an image itself.
   *
   * A text-only model has to be handed a transcription of the picture instead,
   * which is a materially worse answer, so this is not a cosmetic capability
   * flag — it decides which of two paths a run takes.
   */
  readonly vision: boolean
  readonly rate: ModelRate
}

const SPECS: readonly ProxyModelSpec[] = [
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    label: 'Flash',
    vision: false,
    rate: { cacheHitIn: 0.0028, cacheMissIn: 0.14, output: 0.28 },
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    label: 'Pro',
    vision: false,
    rate: { cacheHitIn: 0.0145, cacheMissIn: 1.74, output: 3.48 },
  },
  {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    label: 'Luna',
    vision: true,
    rate: { cacheHitIn: 0.02, cacheMissIn: 0.2, output: 1.2 },
  },
]

const SPEC_BY_ID = new Map<string, ProxyModelSpec>(SPECS.map((spec) => [spec.id, spec]))

/** Fallback rate for unknown models — the cheap flash tier (never over-bills). */
const DEFAULT_RATE: ModelRate = SPEC_BY_ID.get('deepseek-v4-flash')!.rate

export const PROXY_MODEL_SPECS: readonly ProxyModelSpec[] = SPECS

/**
 * Canonicalize a provider/model id to one of our priced models. DeepSeek's
 * retired chat/reasoner aliases both resolve to V4 Flash (non-thinking/thinking
 * mode respectively), and clients may send
 * short/versioned ids; we normalize so allow-list checks AND pricing are exact.
 */
const MODEL_ALIASES: Record<string, ProxyModel> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
  luna: 'gpt-5.6-luna',
}

const isProxyModel = (value: string): value is ProxyModel =>
  (PROXY_MODELS as readonly string[]).includes(value)

export function canonicalModel(raw: string | undefined | null): ProxyModel {
  if (!raw) return 'deepseek-v4-flash'
  const key = raw.trim().toLowerCase()
  if (isProxyModel(key)) return key
  const alias = MODEL_ALIASES[key]
  if (alias) return alias
  // Heuristic for unseen ids. Checked before the pro/reason heuristic because
  // an OpenAI id is a different *provider*, and guessing DeepSeek for it would
  // send the request upstream with the wrong key rather than merely misprice it.
  if (key.startsWith('gpt-') || key.includes('luna')) return 'gpt-5.6-luna'
  if (key.includes('pro') || key.includes('reason')) return 'deepseek-v4-pro'
  return 'deepseek-v4-flash'
}

export function rateFor(modelId: string): ModelRate {
  return SPEC_BY_ID.get(modelId)?.rate ?? DEFAULT_RATE
}

export function specFor(modelId: string): ProxyModelSpec {
  return SPEC_BY_ID.get(modelId) ?? SPEC_BY_ID.get(canonicalModel(modelId))!
}

/** Who serves this model — decides which upstream and which stored key to use. */
export function providerOf(modelId: string): ModelProvider {
  return specFor(modelId).provider
}

/**
 * Which model a run picks when a member is granted more than one, best first.
 *
 * The grant is a set, not an ordering, so something has to break the tie. An
 * admin who adds a model to somebody's grant is asking for that model to be
 * used — nobody grants Luna hoping the run keeps choosing Flash — so the best
 * granted model wins and removing it is how you go back.
 *
 * Luna leads on capability, not price: it reasons better than either DeepSeek
 * tier and it is the only model here that can look at a picture.
 */
export const RUNTIME_MODEL_PREFERENCE = [
  'gpt-5.6-luna',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
] as const satisfies readonly ProxyModel[]

/** The lowest-privilege model, and what a member with no grant at all runs on. */
export const DEFAULT_MODEL: ProxyModel = 'deepseek-v4-flash'

/** Models available to every unblocked member before an admin customizes access. */
export const DEFAULT_ALLOWED_MODELS: readonly ProxyModel[] = [
  DEFAULT_MODEL,
  'deepseek-v4-pro',
  'gpt-5.6-luna',
]

/**
 * The model a run should use, given what its member is allowed.
 *
 * Falls back to the default rather than refusing: the allow-list is enforced
 * again at the proxy, and that is the one place that audits a denial and
 * phrases it. Deciding here as well would produce two different refusals for
 * the same cause.
 */
export function bestGrantedModel(allowed: readonly string[]): ProxyModel {
  const granted = new Set(allowed.map((id) => canonicalModel(id)))
  return RUNTIME_MODEL_PREFERENCE.find((model) => granted.has(model)) ?? DEFAULT_MODEL
}

/** Whether this model can be shown a picture rather than a transcription of one. */
export function supportsVision(modelId: string): boolean {
  return specFor(modelId).vision
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
