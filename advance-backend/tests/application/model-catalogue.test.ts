import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROXY_MODELS,
  PROXY_MODEL_SPECS,
  canonicalModel,
  costUsd,
  providerOf,
  bestGrantedModel,
  supportsVision,
} from '../../src/application/observability/pricing.ts';
import { ProxyKeyStore } from '../../src/application/proxy/proxy-key.store.ts';

describe('model catalogue', () => {
  it('keeps the legacy DeepSeek aliases pointing at the models that replaced them', () => {
    assert.equal(canonicalModel('deepseek-chat'), 'deepseek-v4-flash');
    assert.equal(canonicalModel('deepseek-reasoner'), 'deepseek-v4-flash');
  });

  it('prefers Luna, then Flash, then Pro when multiple models are granted', () => {
    assert.equal(bestGrantedModel(['deepseek-v4-pro', 'deepseek-v4-flash']), 'deepseek-v4-flash');
    assert.equal(bestGrantedModel(['deepseek-v4-flash', 'gpt-5.6-luna']), 'gpt-5.6-luna');
  });

  // An unknown id used to fall through to the pro/reason heuristic, which is a
  // DeepSeek answer. For an OpenAI id that is not a mispricing, it is the wrong
  // upstream signed with the wrong key — so the provider guess has to come first.
  it('does not mistake an OpenAI id for a DeepSeek model', () => {
    assert.equal(canonicalModel('gpt-5.6-luna'), 'gpt-5.6-luna');
    assert.equal(canonicalModel('luna'), 'gpt-5.6-luna');
    assert.equal(canonicalModel('gpt-5.6-luna-preview'), 'gpt-5.6-luna');
    assert.equal(providerOf(canonicalModel('gpt-5.6-luna')), 'openai');
  });

  it('still routes an unrecognised id to the cheapest model rather than guessing high', () => {
    assert.equal(canonicalModel('something-nobody-has-heard-of'), 'deepseek-v4-flash');
    assert.equal(canonicalModel(undefined), 'deepseek-v4-flash');
  });

  it('names exactly which models can see an image', () => {
    assert.equal(supportsVision('gpt-5.6-luna'), true);
    assert.equal(supportsVision('deepseek-v4-flash'), false);
    assert.equal(supportsVision('deepseek-v4-pro'), false);
  });

  it('prices Luna at its post-cut rate', () => {
    // 1M cache-missed input + 1M output = $0.20 + $1.20.
    const cost = costUsd('gpt-5.6-luna', { cacheMissIn: 1_000_000, cacheHitIn: 0, output: 1_000_000 });

    assert.equal(Number(cost.toFixed(4)), 1.4);
  });

  it('offers every catalogue model to the admin grant', () => {
    assert.deepEqual([...PROXY_MODELS], ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-luna']);
  });

  // The container cannot import this module, so the same three facts live twice.
  // Drift is silent in both directions and neither failure is legible from the
  // outside: a model added only here is granted and then rejected by the
  // controller as `invalid_model`, and a vision flag set only here tells a run
  // to look at a picture with a model that cannot see.
  it('agrees with the table the container reads', async () => {
    const { RUNTIME_MODELS, VISION_MODELS } = await import(
      '../../../divo-pi/divo/runtime-models.mjs' as string
    ) as { RUNTIME_MODELS: Record<string, string>; VISION_MODELS: Set<string> };

    assert.deepEqual(Object.keys(RUNTIME_MODELS).sort(), [...PROXY_MODELS].sort());
    for (const spec of PROXY_MODEL_SPECS) {
      assert.equal(RUNTIME_MODELS[spec.id], spec.provider, `provider for ${spec.id}`);
      assert.equal(VISION_MODELS.has(spec.id), spec.vision, `vision for ${spec.id}`);
    }
  });
});

// A company that has saved no key must be told so, not quietly billed against
// whatever the process happened to be started with. Both the 503 and the panel's
// "not configured" only exist if resolve() and status() can report nothing.
describe('provider keys', () => {
  const emptyStore = () =>
    new ProxyKeyStore({
      prisma: { proxyProviderKey: { findMany: async () => [] } } as never,
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } } as never,
      encryptionKey: 'a'.repeat(64),
    });

  it('has no key for either provider until an admin saves one', async () => {
    const store = emptyStore();

    for (const provider of ['openai', 'deepseek'] as const) {
      assert.equal(await store.resolve(provider, 'company-1'), null, `resolve ${provider}`);
      assert.equal((await store.status(provider, 'company-1')).configured, false, `status ${provider}`);
    }
  });
});
