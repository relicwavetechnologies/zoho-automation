/**
 * Fallback embedding provider — deterministic, no network calls, never fails.
 *
 * Used when:
 *   a. EMBEDDING_PROVIDER='fallback' is explicitly configured, or
 *   b. The real provider (OpenAI / Gemini) fails a batch → the service substitutes
 *      per-item deterministic vectors so the rest of the pipeline is not blocked.
 *
 * Algorithm: for each dimension index i, hash `${i}:${normalizedText}` with SHA-256
 * and use `bytes[i % 32] / 255` as the component value → stable [0, 1] range.
 * Empty text → zero vector.
 *
 * Dimension is 1536 to match the default OpenAI text-embedding-3-small model.
 */

import { createHash } from 'crypto';
import type {
  EmbeddingDocumentInput,
  EmbeddingModality,
  EmbeddingProvider,
  MediaAnalysisInput,
  MediaAnalysisResult,
} from './types';

export const FALLBACK_DIMENSION = 1536;

const normalizeText = (t: string): string => t.trim().replace(/\s+/g, ' ');

export function deterministicVector(text: string, dimension: number): number[] {
  const normalized = normalizeText(text);
  if (!normalized) return Array.from({ length: dimension }, () => 0);
  const vec = new Array<number>(dimension);
  for (let i = 0; i < dimension; i++) {
    const digest = createHash('sha256').update(`${i}:${normalized}`).digest();
    const byte = digest[i % digest.length];
    vec[i] = (byte ?? 0) / 255;
  }
  return vec;
}

function inputText(input: EmbeddingDocumentInput): string {
  return [input.title, input.text].filter(Boolean).join('\n');
}

export class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'fallback' as const;
  readonly textDimension = FALLBACK_DIMENSION;
  readonly multimodalDimension = FALLBACK_DIMENSION;

  async embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return inputs.map(i => deterministicVector(inputText(i), this.textDimension));
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    return texts.map(t => deterministicVector(t, this.textDimension));
  }

  async embedMultimodal(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return this.embedDocuments(inputs);
  }

  async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysisResult> {
    const modality: EmbeddingModality = input.mimeType.startsWith('video/') ? 'video' : 'image';
    return {
      modality,
      summary: [
        `${modality.toUpperCase()} asset: ${input.fileName}`,
        `mimeType=${input.mimeType}`,
        input.cloudinaryUrl ? `url=${input.cloudinaryUrl}` : '',
      ].filter(Boolean).join('\n'),
      metadata: { mimeType: input.mimeType },
    };
  }
}
