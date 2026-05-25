import { wrapLanguageModel } from 'ai';
import type { createOpenAI } from '@ai-sdk/openai';

// LanguageModelV3 is the type returned by provider factories like openai() / google().
// We derive it here so we don't need a direct @ai-sdk/provider dep.
type LanguageModelV3 = ReturnType<ReturnType<typeof createOpenAI>>;

function isTransientProviderError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'TimeoutError') return true;
  if (e instanceof Error && e.name === 'AbortError')   return true;

  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('try again later') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('503') ||
    msg.includes('429')
  );
}

/**
 * Wraps `primary` so any transient availability error falls back to
 * `fallback` after a SINGLE attempt (no SDK retries on primary).
 * Non-transient errors (bad args, auth, malformed history, etc.)
 * are re-thrown so callers can fix them.
 */
export function withFallback(primary: LanguageModelV3, fallback: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({
    model: primary,
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }) => {
        const startMs = Date.now();
        try {
          const result = await doGenerate();
          console.log(`[model-fallback] PRIMARY OK (generate) in ${Date.now() - startMs}ms — model: ${primary.modelId}`);
          return result;
        } catch (e) {
          if (!isTransientProviderError(e)) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[model-fallback] PRIMARY FAILED (generate) after ${Date.now() - startMs}ms — ${primary.modelId} → falling back to ${fallback.modelId}. Error: ${msg.slice(0, 200)}`);
          const fallbackStartMs = Date.now();
          const { abortSignal: _dropped, ...fallbackParams } = params as typeof params & { abortSignal?: unknown };
          const result = await fallback.doGenerate(fallbackParams as typeof params);
          console.log(`[model-fallback] FALLBACK OK (generate) in ${Date.now() - fallbackStartMs}ms — model: ${fallback.modelId}`);
          return result;
        }
      },
      wrapStream: async ({ doStream, params }) => {
        const startMs = Date.now();
        try {
          const result = await doStream();
          console.log(`[model-fallback] PRIMARY OK (stream) in ${Date.now() - startMs}ms — model: ${primary.modelId}`);
          return result;
        } catch (e) {
          if (!isTransientProviderError(e)) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[model-fallback] PRIMARY FAILED (stream) after ${Date.now() - startMs}ms — ${primary.modelId} → falling back to ${fallback.modelId}. Error: ${msg.slice(0, 200)}`);
          const fallbackStartMs = Date.now();
          const { abortSignal: _dropped, ...fallbackParams } = params as typeof params & { abortSignal?: unknown };
          const result = await fallback.doStream(fallbackParams as typeof params);
          console.log(`[model-fallback] FALLBACK OK (stream) in ${Date.now() - fallbackStartMs}ms — model: ${fallback.modelId}`);
          return result;
        }
      },
    },
  });
}
