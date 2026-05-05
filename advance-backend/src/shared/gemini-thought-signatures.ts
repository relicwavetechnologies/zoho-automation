/**
 * Gemini thought-signature correctness layer — two-layer defence.
 *
 * ── Layer 1: Response fix (createGeminiFetch) ───────────────────────────────
 * Root cause: Gemini 3.x thinking models sometimes return the `thoughtSignature`
 * on an EMPTY TEXT part that precedes the `functionCall` part in the same
 * response, rather than on the `functionCall` part itself (cloudwego/eino-ext#756).
 *
 * The `@ai-sdk/google` parser (v3.0.64) drops that signature silently:
 *   doGenerate: when the empty-text part arrives before any content,
 *     `content.length === 0` so the `if (thoughtSignatureMetadata != null &&
 *     content.length > 0)` guard fires → sig discarded.
 *   doStream: when the empty-text chunk arrives without an active text block,
 *     `currentTextBlockId === null` → chunk never enqueued → sig discarded.
 *
 * Fix: `createGeminiFetch()` returns a wrapped fetch that intercepts every
 * Gemini API response and moves the orphan signature from whatever part it
 * arrived on to the FIRST functionCall part — before the SDK parser ever sees
 * the bytes. Supply it via `createGoogleGenerativeAI({ fetch: createGeminiFetch() })`.
 *
 * ── Layer 2: Prompt fix (withGeminiSignatures / correctPromptSignatures) ────
 * Defence-in-depth for the outgoing direction: if somehow the SDK still builds
 * a multi-turn prompt where the first tool-call part lacks a signature but a
 * sibling text/reasoning part carries one, `transformParams` salvages it.
 * This layer is a no-op when Layer 1 works correctly.
 *
 * Spec invariants enforced by both layers:
 *   - Signature must be on the FIRST functionCall of a model turn.
 *   - Subsequent parallel functionCall parts must NOT gain a sig.
 *   - Text-only turns: sig stays on the text part (untouched).
 */

import { wrapLanguageModel } from 'ai';
import type { createOpenAI } from '@ai-sdk/openai';

// ─── Type aliases ────────────────────────────────────────────────────────────

type LanguageModelV3 = ReturnType<ReturnType<typeof createOpenAI>>;
type GeminiPart      = Record<string, unknown>;

// ─── Layer 1: Response-level fix ─────────────────────────────────────────────

/**
 * Within a single Gemini response candidate's parts array, if the first
 * functionCall part has no thoughtSignature but any other part does, copy
 * it over. Returns the same array reference if no change is needed.
 */
function fixGeminiParts(parts: GeminiPart[]): GeminiPart[] {
  const firstFnIdx = parts.findIndex(
    p => 'functionCall' in p && !('thoughtSignature' in p),
  );
  if (firstFnIdx < 0) return parts;

  let orphanSig: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    if (i === firstFnIdx) continue;
    const s = parts[i]!['thoughtSignature'];
    if (typeof s === 'string' && s.length > 0) { orphanSig = s; break; }
  }
  if (!orphanSig) return parts;

  const result = parts.slice();
  result[firstFnIdx] = { ...parts[firstFnIdx]!, thoughtSignature: orphanSig };
  return result;
}

/**
 * Walk a complete Gemini API response JSON and fix sig attribution in each
 * candidate's parts. Returns the same object reference if nothing changed.
 */
function fixGeminiResponseJson(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return json;
  const obj        = json as Record<string, unknown>;
  const candidates = obj['candidates'];
  if (!Array.isArray(candidates)) return json;

  let changed = false;
  const fixedCandidates = candidates.map(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return candidate;
    const c       = candidate as Record<string, unknown>;
    const content = c['content'];
    if (typeof content !== 'object' || content === null) return candidate;
    const cc    = content as Record<string, unknown>;
    const parts = cc['parts'];
    if (!Array.isArray(parts)) return candidate;

    const fixedParts = fixGeminiParts(parts as GeminiPart[]);
    if (fixedParts === parts) return candidate;

    changed = true;
    return { ...c, content: { ...cc, parts: fixedParts } };
  });

  return changed ? { ...obj, candidates: fixedCandidates } : json;
}

/** Wrap a non-streaming generateContent response: parse JSON, fix, re-wrap. */
async function fixNonStreamingResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const text = await response.text();
  try {
    const fixed = fixGeminiResponseJson(JSON.parse(text));
    const body  = fixed === JSON.parse(text) ? text : JSON.stringify(fixed);
    return new Response(body, {
      status:     response.status,
      statusText: response.statusText,
      headers:    response.headers,
    });
  } catch {
    return new Response(text, {
      status:     response.status,
      statusText: response.statusText,
      headers:    response.headers,
    });
  }
}

/** Transform a single SSE `data: {...}` line, fixing sig attribution. */
function fixSseLine(line: string): string {
  if (!line.startsWith('data: ')) return line;
  try {
    const fixed = fixGeminiResponseJson(JSON.parse(line.slice(6)));
    return `data: ${JSON.stringify(fixed)}`;
  } catch {
    return line;
  }
}

/** Wrap a streaming streamGenerateContent response: transform each SSE chunk. */
function fixStreamingResponse(response: Response): Response {
  if (!response.body || !response.ok) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        controller.enqueue(encoder.encode(fixSseLine(line) + '\n'));
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(fixSseLine(buffer)));
    },
  });

  response.body.pipeTo(transform.writable).catch(() => { /* stream errors propagate via readable */ });

  return new Response(transform.readable, {
    status:     response.status,
    statusText: response.statusText,
    headers:    response.headers,
  });
}

/**
 * Create a fetch function suitable for `createGoogleGenerativeAI({ fetch })`.
 * Intercepts Gemini API responses and guarantees that thoughtSignatures are
 * always on the first functionCall part, not on an adjacent text part.
 *
 * Pass an optional `baseFetch` to chain with another fetch wrapper (e.g. for
 * testing or additional middleware). Defaults to `globalThis.fetch`.
 */
export function createGeminiFetch(
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = String(args[0]);
    if (!url.includes('generativelanguage.googleapis.com')) {
      return baseFetch(...args);
    }

    const response = await baseFetch(...args);

    // Streaming endpoint — alt=sse or streamGenerateContent
    if (url.includes(':streamGenerateContent') || url.includes('alt=sse')) {
      return fixStreamingResponse(response);
    }

    // Non-streaming endpoint — generateContent
    if (url.includes(':generateContent')) {
      return fixNonStreamingResponse(response);
    }

    return response;
  };
}

// ─── Layer 2: Prompt-level fix (defence-in-depth) ────────────────────────────

/** Generic shape for prompt messages and their parts. */
interface PromptPart {
  type:             string;
  providerOptions?: Record<string, Record<string, unknown> | undefined>;
  [k: string]:      unknown;
}

interface PromptMessage {
  role:    'system' | 'user' | 'assistant' | 'tool';
  content: string | ReadonlyArray<PromptPart> | unknown;
  [k: string]: unknown;
}

const GOOGLE_KEY = 'google';
const SIG_FIELD  = 'thoughtSignature';

function getSig(part: PromptPart | undefined): string | undefined {
  if (!part?.providerOptions) return undefined;
  const g = part.providerOptions[GOOGLE_KEY];
  if (!g) return undefined;
  const s = g[SIG_FIELD];
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}

function withSig(part: PromptPart, sig: string): PromptPart {
  const existingProvider = part.providerOptions ?? {};
  const existingGoogle   = (existingProvider[GOOGLE_KEY] ?? {}) as Record<string, unknown>;
  return {
    ...part,
    providerOptions: {
      ...existingProvider,
      [GOOGLE_KEY]: { ...existingGoogle, [SIG_FIELD]: sig },
    },
  };
}

function correctAssistantParts(parts: ReadonlyArray<PromptPart>): ReadonlyArray<PromptPart> {
  const firstToolCallIdx = parts.findIndex(p => p.type === 'tool-call');
  if (firstToolCallIdx < 0) return parts;

  const firstToolCall = parts[firstToolCallIdx]!;
  if (getSig(firstToolCall)) return parts;

  let orphanSig: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    if (i === firstToolCallIdx) continue;
    const sig = getSig(parts[i]);
    if (sig) { orphanSig = sig; break; }
  }
  if (!orphanSig) return parts;

  const fixed = parts.slice() as PromptPart[];
  fixed[firstToolCallIdx] = withSig(firstToolCall, orphanSig);
  return fixed;
}

export function correctPromptSignatures(
  prompt: ReadonlyArray<PromptMessage>,
): ReadonlyArray<PromptMessage> {
  let mutated = false;
  const out: PromptMessage[] = [];
  for (const msg of prompt) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const parts     = msg.content as ReadonlyArray<PromptPart>;
    const corrected = correctAssistantParts(parts);
    if (corrected !== parts) {
      mutated = true;
      out.push({ ...msg, content: corrected });
    } else {
      out.push(msg);
    }
  }
  return mutated ? out : prompt;
}

/**
 * Defence-in-depth: wrap a LanguageModelV3 so `transformParams` scrubs the
 * outgoing prompt. Normally a no-op when `createGeminiFetch` is in place;
 * useful as a standalone fix when using a non-Google provider.
 */
export function withGeminiSignatures(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      transformParams: async ({ params }) => {
        const prompt = (params as { prompt?: ReadonlyArray<PromptMessage> }).prompt;
        if (!prompt) return params;
        const corrected = correctPromptSignatures(prompt);
        if (corrected === prompt) return params;
        return { ...params, prompt: corrected } as typeof params;
      },
    },
  });
}
