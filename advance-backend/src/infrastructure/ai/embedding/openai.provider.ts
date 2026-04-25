/**
 * OpenAI embedding provider using the Vercel AI SDK (@ai-sdk/openai + ai).
 *
 * Supports:
 *   text-embedding-3-small  → 1536 dimensions
 *   text-embedding-3-large  → 3072 dimensions
 *   text-embedding-ada-002  → 1536 dimensions
 *
 * Uses `embedMany` from the `ai` package (Vercel AI SDK) which automatically
 * handles rate-limit retries and request chunking.
 *
 * Both embedDocuments and embedQueries call the same model; OpenAI's
 * text-embedding-3-* models do not distinguish task types at the API level.
 */

import { embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingDocumentInput, EmbeddingProvider } from './types';

const OPENAI_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

const DEFAULT_DIMENSION = 1536;

function inputText(input: EmbeddingDocumentInput): string {
  return [input.title, input.text].filter(Boolean).join('\n');
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai' as const;
  readonly textDimension: number;
  readonly multimodalDimension: number;

  private readonly model: ReturnType<ReturnType<typeof createOpenAI>['embedding']>;

  constructor(opts: { apiKey: string; model: string }) {
    this.textDimension = OPENAI_DIMENSIONS[opts.model] ?? DEFAULT_DIMENSION;
    this.multimodalDimension = this.textDimension;

    const openai = createOpenAI({ apiKey: opts.apiKey });
    this.model = openai.embedding(opts.model);
  }

  private normalize(vectors: number[][]): number[][] {
    return vectors.map(v => {
      if (v.length === this.textDimension) return v;
      if (v.length > this.textDimension)   return v.slice(0, this.textDimension);
      return [...v, ...Array.from({ length: this.textDimension - v.length }, () => 0)];
    });
  }

  async embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const { embeddings } = await embedMany({
      model: this.model,
      values: inputs.map(inputText),
    });
    return this.normalize(embeddings);
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { embeddings } = await embedMany({
      model: this.model,
      values: texts,
    });
    return this.normalize(embeddings);
  }

  async embedMultimodal(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    // OpenAI text-embedding models don't have a separate multimodal variant —
    // delegate to embedDocuments which uses the same model.
    return this.embedDocuments(inputs);
  }
}
