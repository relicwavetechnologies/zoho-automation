import { logger } from '../../../utils/logger';
import type {
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

  async embedText(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    const batches = chunk(texts, this.batchSize);
    const vectors: number[][] = [];

    for (const batch of batches) {
      try {
        const chunkVectors = await this.provider.embedText(batch);
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
          totalInputs: texts.length,
          error,
        });
        throw error;
      }
    }

    logger.success('embedding.batch.success', {
      provider: this.provider.provider,
      batchSize: this.batchSize,
      totalInputs: texts.length,
      totalBatches: batches.length,
      latencyMs: Date.now() - startedAt,
    });

    return vectors;
  }

  async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysisResult> {
    if (!this.provider.analyzeMedia) {
      throw new Error(`embedding provider ${this.provider.provider} does not support media analysis`);
    }

    return this.provider.analyzeMedia(input);
  }

  async embedMediaSummary(input: MediaAnalysisInput): Promise<EmbeddedMediaSummary> {
    const analysis = await this.analyzeMedia(input);
    const [embedding] = await this.embedText([analysis.summary]);
    return {
      ...analysis,
      embedding,
    };
  }

  async embed(input: string[]): Promise<number[][]> {
    return this.embedText(input);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedText([text]);
    return embedding;
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
