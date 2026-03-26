import { createHash } from 'crypto';

import { logger } from '../../../utils/logger';
import type {
  EmbeddingDocumentInput,
  EmbeddingModality,
  EmbeddingProvider,
  MediaAnalysisInput,
  MediaAnalysisResult,
} from './embedding-provider';
import { resolveEmbeddingProvider } from './embedding-provider';

type EmbeddingServiceOptions = {
  provider?: EmbeddingProvider;
  batchSize?: number;
};

export type EmbeddedMediaSummary = MediaAnalysisResult & {
  embedding: number[];
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');

const deterministicVector = (text: string, dimension: number): number[] => {
  const normalized = normalizeText(text);
  if (!normalized) {
    return Array.from({ length: dimension }, () => 0);
  }

  const vector = new Array<number>(dimension);
  for (let index = 0; index < dimension; index += 1) {
    const digest = createHash('sha256').update(`${index}:${normalized}`).digest();
    vector[index] = digest[index % digest.length] / 255;
  }

  return vector;
};

const fallbackTextForItem = (item: unknown): string => {
  if (typeof item === 'string') {
    return item;
  }
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : '';
    const text = typeof record.text === 'string' ? record.text : '';
    return [title, text].filter(Boolean).join('\n');
  }
  return '';
};

export class EmbeddingService {
  private readonly provider: EmbeddingProvider;

  private readonly batchSize: number;

  constructor(options: EmbeddingServiceOptions = {}) {
    this.provider = options.provider ?? resolveEmbeddingProvider();
    this.batchSize = Math.max(1, options.batchSize ?? 16);
  }

  get providerName(): EmbeddingProvider['provider'] {
    return this.provider.provider;
  }

  get dimension(): number {
    return this.provider.dimension;
  }

  private async embedBatches<T>(
    items: T[],
    embedder: (batch: T[]) => Promise<number[][]>,
  ): Promise<number[][]> {
    if (items.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    const batches = chunk(items, this.batchSize);
    const vectors: number[][] = [];

    for (const batch of batches) {
      try {
        const chunkVectors = await embedder(batch);
        if (chunkVectors.length !== batch.length) {
          throw new Error('embedding provider returned mismatched vector count');
        }

        chunkVectors.forEach((vector) => {
          if (vector.length !== this.dimension) {
            throw new Error('embedding vector dimension mismatch');
          }
          vectors.push(vector);
        });
      } catch (error) {
        logger.error('embedding.batch.failed', {
          provider: this.provider.provider,
          batchSize: batch.length,
          totalInputs: items.length,
          error,
        });
        const errorMessage = error instanceof Error ? error.message : 'unknown_error';
        const fallbackVectors = batch.map((item) =>
          deterministicVector(fallbackTextForItem(item), this.dimension));
        logger.warn('embedding.batch.fallback_applied', {
          provider: this.provider.provider,
          batchSize: batch.length,
          totalInputs: items.length,
          error: errorMessage,
          classifiedReason: errorMessage.includes('HTTP 429') ? 'embedding_rate_limited' : 'embedding_unavailable',
          nonFatal: true,
          degradedBehavior: 'fallback_deterministic_embeddings',
          fallbackDimension: this.dimension,
        });
        vectors.push(...fallbackVectors);
      }
    }

    logger.success('embedding.batch.success', {
      provider: this.provider.provider,
      batchSize: this.batchSize,
      totalInputs: items.length,
      totalBatches: batches.length,
      latencyMs: Date.now() - startedAt,
    });

    return vectors;
  }

  async embedDocuments(inputs: Array<string | EmbeddingDocumentInput>): Promise<number[][]> {
    return this.embedBatches(
      inputs.map((input) => (typeof input === 'string' ? { text: input } : input)),
      (batch) => this.provider.embedDocuments(batch),
    );
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    return this.embedBatches(texts, (batch) => this.provider.embedQueries(batch));
  }

  async embedMultimodalDocuments(
    inputs: Array<string | EmbeddingDocumentInput>,
  ): Promise<number[][]> {
    const normalized = inputs.map((input) => (typeof input === 'string' ? { text: input } : input));
    if (this.provider.embedMultimodalDocuments) {
      try {
        return await this.embedBatches(normalized, (batch) =>
          this.provider.embedMultimodalDocuments!(batch),
        );
      } catch (error) {
        logger.warn('embedding.multimodal.fallback_to_documents', {
          provider: this.provider.provider,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    }
    return this.embedDocuments(normalized);
  }

  async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysisResult> {
    if (!this.provider.analyzeMedia) {
      throw new Error(
        `embedding provider ${this.provider.provider} does not support media analysis`,
      );
    }

    return this.provider.analyzeMedia(input);
  }

  async embedMediaSummary(input: MediaAnalysisInput): Promise<EmbeddedMediaSummary> {
    const analysis = await this.analyzeMedia(input);
    const [embedding] = await this.embedDocuments([
      { text: analysis.summary, title: input.fileName },
    ]);
    return {
      ...analysis,
      embedding,
    };
  }

  async embed(input: string[]): Promise<number[][]> {
    return this.embedDocuments(input);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedQueries([text]);
    return embedding;
  }

  async embedText(texts: string[]): Promise<number[][]> {
    return this.embedDocuments(texts);
  }

  modalityForMimeType(mimeType: string): EmbeddingModality {
    if (mimeType.startsWith('image/')) {
      return 'image';
    }
    if (mimeType.startsWith('video/')) {
      return 'video';
    }
    return 'text';
  }
}

export const embeddingService = new EmbeddingService();
