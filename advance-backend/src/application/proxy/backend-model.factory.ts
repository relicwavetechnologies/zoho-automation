/**
 * The model a backend-side job runs on, and the key that pays for it.
 *
 * Background work — follow-up analysis, summaries, learning — never had this.
 * Each worker was handed one `LanguageModel` built at boot from a provider SDK
 * pointed at a process environment variable, which had three consequences that
 * only became visible together:
 *
 *  - the model was fixed at DeepSeek, so moving Divo's default to Spark moved
 *    every member and left every worker behind;
 *  - the credential was `DEEPSEEK_API_KEY`, so when that account ran out of
 *    balance the analysis failed on every chat with `Insufficient Balance`
 *    while the Guardrails page showed a healthy, funded Meta key;
 *  - one process-wide key paid for every company on the install, which is not
 *    something a multi-tenant install should be able to express.
 *
 * So the model id decides the provider, and the provider's key is resolved per
 * company from the same store the Guardrails page writes. An admin who replaces
 * a key there changes what the workers spend, which is what they already
 * believe that page does.
 *
 * This is deliberately *not* Divo's `/api/llm/v1` proxy. That is mounted behind
 * member authentication and prices against a member's budget; a company-wide
 * sweep has no member, and inventing one to borrow the plumbing would put a
 * background job's spend on somebody's personal allowance. The trade is real
 * and worth naming: these calls carry no `ProxyRequestLog` row.
 */

import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { providerOf, type ModelProvider } from '../observability/pricing';

export interface BackendModelKeySource {
  resolve(provider: ModelProvider, companyId: string): Promise<{ key: string } | null>;
}

export interface BackendModelFactoryDeps {
  readonly keys: BackendModelKeySource;
  readonly baseUrls: Readonly<Record<ModelProvider, string>>;
}

/** No key for the provider this model needs. Named so a caller can say why. */
export class BackendModelUnavailable extends Error {
  constructor(readonly provider: ModelProvider, readonly companyId: string) {
    super(
      `No ${provider} key is configured for this company. `
      + 'Add one under Settings → Company → Guardrails.',
    );
    this.name = 'BackendModelUnavailable';
  }
}

export type BackendModelResolver = (input: {
  modelId: string;
  companyId: string;
}) => Promise<LanguageModel>;

export function createBackendModelResolver(deps: BackendModelFactoryDeps): BackendModelResolver {
  /*
   * Keyed on the credential as well as the provider.
   *
   * Two companies on different keys must not share a client, and a key rotated
   * on Guardrails has to take effect without a restart. Including the key in
   * the identity gets both: a rotation simply misses the cache.
   */
  const clients = new Map<string, LanguageModel>();

  return async ({ modelId, companyId }) => {
    const provider = providerOf(modelId);
    const resolved = await deps.keys.resolve(provider, companyId);
    if (!resolved) throw new BackendModelUnavailable(provider, companyId);

    const cacheKey = `${provider}:${modelId}:${resolved.key.slice(-8)}`;
    const cached = clients.get(cacheKey);
    if (cached) return cached;

    const model = build(provider, modelId, resolved.key, deps.baseUrls[provider]);
    clients.set(cacheKey, model);
    return model;
  };
}

function build(
  provider: ModelProvider,
  modelId: string,
  apiKey: string,
  baseUrl: string,
): LanguageModel {
  if (provider === 'deepseek') {
    return createDeepSeek({ apiKey, baseURL: `${trimSlash(baseUrl)}/v1` })(modelId);
  }
  /*
   * Chat completions rather than the Responses API, for both OpenAI-shaped
   * providers.
   *
   * `generateObject` is what every one of these jobs actually calls, and the
   * chat surface is the one it has always run through here. Meta serves the
   * same shape — verified against `api.meta.ai`, which answers 200 to both
   * `/v1/chat/completions` and `/v1/responses` — so Spark needs no separate
   * transport, and switching surfaces would change how structured output is
   * requested for a benefit nothing here is asking for.
   */
  return createOpenAI({ apiKey, baseURL: `${trimSlash(baseUrl)}/v1` }).chat(modelId);
}

const trimSlash = (value: string): string => value.replace(/\/+$/, '');
