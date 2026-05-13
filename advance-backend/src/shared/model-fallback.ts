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
 * Wraps `primary` so any transient availability error silently falls back to
 * `fallback`. Non-transient errors (bad args, auth, malformed history, etc.)
 * are re-thrown so callers can fix them.
 */
export function withFallback(primary: LanguageModelV3, fallback: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({
    model: primary,
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return await doGenerate();
        } catch (e) {
          if (!isTransientProviderError(e)) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[model-fallback] PRIMARY FAILED (generate), falling back. Error: ${msg.slice(0, 200)}`);
          const { abortSignal: _dropped, ...fallbackParams } = params as typeof params & { abortSignal?: unknown };
          return await fallback.doGenerate(fallbackParams as typeof params);
        }
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (e) {
          if (!isTransientProviderError(e)) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[model-fallback] PRIMARY FAILED (stream), falling back. Error: ${msg.slice(0, 200)}`);
          const { abortSignal: _dropped, ...fallbackParams } = params as typeof params & { abortSignal?: unknown };
          return await fallback.doStream(fallbackParams as typeof params);
        }
      },
    },
  });
}
