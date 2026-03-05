import { createHash } from 'crypto';

import { OpenAIEmbeddings } from '@langchain/openai';

import config from '../../../config';
import { logger } from '../../../utils/logger';

export type EmbeddingProviderType = 'openai' | 'fallback';

export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderType;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

const OPENAI_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

const FALLBACK_DIMENSION = 1536;

const normalizeText = (text: string): string => text.trim().replace(/\s+/g, ' ');

const deterministicVector = (text: string, dimension: number): number[] => {
  const normalized = normalizeText(text);
  if (!normalized) {
    return Array.from({ length: dimension }, () => 0);
  }

  const vector = new Array<number>(dimension);
  for (let index = 0; index < dimension; index += 1) {
    const digest = createHash('sha256')
      .update(`${index}:${normalized}`)
      .digest();
    vector[index] = digest[index % digest.length] / 255;
  }

  return vector;
};

export class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'fallback' as const;

  readonly dimension = FALLBACK_DIMENSION;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicVector(text, this.dimension));
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai' as const;

  readonly dimension: number;

  private readonly client: OpenAIEmbeddings;

  constructor() {
    this.dimension = OPENAI_DIMENSIONS[config.OPENAI_EMBEDDING_MODEL] ?? FALLBACK_DIMENSION;
    this.client = new OpenAIEmbeddings({
      model: config.OPENAI_EMBEDDING_MODEL,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const vectors = await this.client.embedDocuments(texts);
      return vectors.map((vector) => {
        if (vector.length === this.dimension) {
          return vector;
        }

        if (vector.length > this.dimension) {
          return vector.slice(0, this.dimension);
        }

        return [...vector, ...Array.from({ length: this.dimension - vector.length }, () => 0)];
      });
    } catch (error) {
      logger.warn('embedding.provider.openai.failed', {
        model: config.OPENAI_EMBEDDING_MODEL,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
      throw error;
    }
  }
}

export const resolveEmbeddingProvider = (): EmbeddingProvider => {
  if (config.EMBEDDING_PROVIDER === 'openai' && process.env.OPENAI_API_KEY?.trim()) {
    return new OpenAiEmbeddingProvider();
  }

  return new FallbackEmbeddingProvider();
};
