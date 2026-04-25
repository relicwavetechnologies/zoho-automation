/**
 * EmbeddingService — provider-agnostic embedding orchestrator.
 *
 * Responsibilities:
 *   1. Chunking — splits large input arrays into `batchSize`-item chunks (default 16).
 *   2. Per-batch fallback — if a batch fails (network, rate-limit, etc.) it logs a warning
 *      and substitutes deterministic SHA-256 vectors so upstream callers are never broken.
 *   3. Multimodal delegation — calls `provider.embedMultimodal` when available, otherwise
 *      falls back to `embedDocuments`.
 *   4. Convenience methods — `embedQuery`, `embedText`, `embedMediaSummary`.
 *
 * Factory:
 *   `createEmbeddingService(env, logger)` reads `env.EMBEDDING_PROVIDER` and creates
 *   the correct provider.  Inject a custom `provider` in tests.
 */

import type { Logger } from '../../../shared/logger';
import type { TypedEnv } from '../../../config/env';
import type {
  EmbeddingDocumentInput,
  EmbeddingProvider,
  MediaAnalysisInput,
  MediaAnalysisResult,
  EmbeddedMediaSummary,
} from './types';
import { FallbackEmbeddingProvider, deterministicVector } from './fallback.provider';
import { OpenAiEmbeddingProvider } from './openai.provider';
import { GeminiEmbeddingProvider } from './gemini.provider';

// ─── Chunk helper ─────────────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function fallbackTextForInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const r = input as Record<string, unknown>;
    return [r['title'], r['text']].filter((v): v is string => typeof v === 'string').join('\n');
  }
  return '';
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly batchSize: number;
  private readonly logger: Logger;

  constructor(opts: {
    provider: EmbeddingProvider;
    logger: Logger;
    batchSize?: number;
  }) {
    this.provider  = opts.provider;
    this.logger    = opts.logger.child({ service: 'embedding' });
    this.batchSize = Math.max(1, opts.batchSize ?? 16);
  }

  get providerName(): EmbeddingProvider['provider'] { return this.provider.provider; }
  get dimension(): number                           { return this.provider.textDimension; }
  get multimodalDimension(): number                 { return this.provider.multimodalDimension; }

  // ── Internal batching + fallback ─────────────────────────────────────────

  private async embedBatches<T>(
    items: T[],
    embedder: (batch: T[]) => Promise<number[][]>,
    dimensionKey: 'textDimension' | 'multimodalDimension' = 'textDimension',
  ): Promise<number[][]> {
    if (items.length === 0) return [];
    const dim     = this.provider[dimensionKey];
    const batches = chunk(items, this.batchSize);
    const vectors: number[][] = [];
    const startedAt = Date.now();

    for (const batch of batches) {
      try {
        const batchVectors = await embedder(batch);
        if (batchVectors.length !== batch.length) {
          throw new Error(
            `Provider returned ${batchVectors.length} vectors for ${batch.length} inputs`,
          );
        }
        vectors.push(...batchVectors);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn('embedding.batch.failed', {
          provider: this.provider.provider,
          batchSize: batch.length,
          totalInputs: items.length,
          reason,
          classifiedReason: reason.includes('429') ? 'rate_limited' : 'upstream_failure',
        });
        // Deterministic fallback — never blocks the pipeline
        for (const item of batch) {
          vectors.push(deterministicVector(fallbackTextForInput(item), dim));
        }
      }
    }

    this.logger.debug('embedding.complete', {
      provider: this.provider.provider,
      totalInputs: items.length,
      totalBatches: batches.length,
      latencyMs: Date.now() - startedAt,
    });

    return vectors;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async embedDocuments(inputs: Array<string | EmbeddingDocumentInput>): Promise<number[][]> {
    const normalized = inputs.map(i => (typeof i === 'string' ? { text: i } : i));
    return this.embedBatches(normalized, batch => this.provider.embedDocuments(batch));
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    return this.embedBatches(texts, batch => this.provider.embedQueries(batch));
  }

  /** Embed a single query string — convenience wrapper around embedQueries. */
  async embedQuery(text: string): Promise<number[]> {
    const vecs = await this.embedQueries([text]);
    const vec = vecs[0];
    if (!vec) throw new Error('embedQuery: provider returned no vectors');
    return vec;
  }

  /** Alias for embedDocuments — accepts plain strings or structured inputs. */
  async embedText(texts: string[]): Promise<number[][]> {
    return this.embedDocuments(texts);
  }

  async embedMultimodal(
    inputs: Array<string | EmbeddingDocumentInput>,
  ): Promise<number[][]> {
    const normalized = inputs.map(i => (typeof i === 'string' ? { text: i } : i));

    if (this.provider.embedMultimodal) {
      try {
        return await this.embedBatches(
          normalized,
          batch => this.provider.embedMultimodal!(batch),
          'multimodalDimension',
        );
      } catch (error) {
        this.logger.warn('embedding.multimodal.fallback', {
          provider: this.provider.provider,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fall back to regular text embedding
    return this.embedDocuments(normalized);
  }

  async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysisResult> {
    if (!this.provider.analyzeMedia) {
      throw new Error(
        `Embedding provider '${this.provider.provider}' does not support media analysis`,
      );
    }
    return this.provider.analyzeMedia(input);
  }

  /** Analyse media and embed the resulting summary — single operation.
   *
   * When the provider supports native multimodal embedding (embedMultimodal),
   * the image bytes are embedded directly alongside the summary text using
   * gemini-embedding-2-preview so visual semantics are captured natively.
   */
  async embedMediaSummary(input: MediaAnalysisInput): Promise<EmbeddedMediaSummary> {
    const analysis = await this.analyzeMedia(input);

    if (this.provider.embedMultimodal) {
      const inputs = [{
        text: analysis.summary,
        title: input.fileName,
        inlineData: { mimeType: input.mimeType, buffer: input.buffer },
      }];
      const vecs = await this.embedBatches(
        inputs,
        batch => this.provider.embedMultimodal!(batch),
        'multimodalDimension',
      );
      const embedding = vecs[0];
      if (embedding) return { ...analysis, embedding };
    }

    const vecs = await this.embedDocuments([{ text: analysis.summary, title: input.fileName }]);
    const embedding = vecs[0];
    if (!embedding) throw new Error('embedMediaSummary: provider returned no vectors');
    return { ...analysis, embedding };
  }

  modalityForMimeType(mimeType: string): 'text' | 'image' | 'video' {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    return 'text';
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an EmbeddingService wired to the correct provider based on env.
 *
 * Provider selection:
 *   'gemini'   → GeminiEmbeddingProvider (requires GEMINI_API_KEY)
 *   'openai'   → OpenAiEmbeddingProvider (requires OPENAI_API_KEY)
 *   'fallback' → FallbackEmbeddingProvider (no network, deterministic)
 *   unset/unknown → falls back to 'openai' if OPENAI_API_KEY present, else 'fallback'
 */
export function createEmbeddingService(env: TypedEnv, logger: Logger): EmbeddingService {
  let provider: EmbeddingProvider;

  if (env.EMBEDDING_PROVIDER === 'gemini' && env.GEMINI_API_KEY) {
    provider = new GeminiEmbeddingProvider({
      apiKey:         env.GEMINI_API_KEY,
      textModel:      env.GEMINI_EMBEDDING_MODEL,
      multimodalModel: env.GEMINI_MULTIMODAL_EMBEDDING_MODEL,
    });
    logger.info('embedding.provider.selected', { provider: 'gemini', model: env.GEMINI_EMBEDDING_MODEL });
  } else if (env.EMBEDDING_PROVIDER !== 'fallback' && env.OPENAI_API_KEY) {
    provider = new OpenAiEmbeddingProvider({
      apiKey: env.OPENAI_API_KEY,
      model:  env.OPENAI_EMBEDDING_MODEL,
    });
    logger.info('embedding.provider.selected', { provider: 'openai', model: env.OPENAI_EMBEDDING_MODEL });
  } else {
    provider = new FallbackEmbeddingProvider();
    logger.warn('embedding.provider.fallback', {
      reason: 'No suitable provider configured; using deterministic fallback',
      configuredProvider: env.EMBEDDING_PROVIDER,
    });
  }

  return new EmbeddingService({ provider, logger });
}

// ─── Re-export types for consumers ────────────────────────────────────────────

export type {
  EmbeddingDocumentInput,
  EmbeddingProvider,
  MediaAnalysisInput,
  MediaAnalysisResult,
  EmbeddedMediaSummary,
  EmbeddingModality,
  EmbeddingProviderName,
} from './types';
