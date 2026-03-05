import { logger } from '../../../utils/logger';
import { EmbeddingProvider, resolveEmbeddingProvider } from './embedding-provider';

type EmbeddingServiceOptions = {
  provider?: EmbeddingProvider;
  batchSize?: number;
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

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    const batches = chunk(texts, this.batchSize);
    const vectors: number[][] = [];

    for (const batch of batches) {
      try {
        const chunkVectors = await this.provider.embed(batch);
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
}

export const embeddingService = new EmbeddingService();
