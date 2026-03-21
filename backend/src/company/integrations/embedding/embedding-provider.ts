import { createHash } from 'crypto';

import { OpenAIEmbeddings } from '@langchain/openai';

import config from '../../../config';
import { logger } from '../../../utils/logger';

export type EmbeddingProviderType = 'gemini' | 'openai' | 'fallback';
export type EmbeddingModality = 'text' | 'image' | 'video';

export type MediaAnalysisInput = {
  mimeType: string;
  fileName: string;
  buffer: Buffer;
  cloudinaryUrl?: string;
};

export type MediaAnalysisResult = {
  modality: EmbeddingModality;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type EmbeddingDocumentInput = {
  text: string;
  title?: string;
};

export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderType;
  readonly dimension: number;
  embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]>;
  embedQueries(texts: string[]): Promise<number[][]>;
  embedMultimodalDocuments?(inputs: EmbeddingDocumentInput[]): Promise<number[][]>;
  analyzeMedia?(input: MediaAnalysisInput): Promise<MediaAnalysisResult>;
}

const OPENAI_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

const GEMINI_DIMENSION = 3072;
const FALLBACK_DIMENSION = 1536;

const GEMINI_EMBEDDING_ENDPOINT = (model: string, apiKey: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;

const GEMINI_GENERATE_ENDPOINT = (model: string, apiKey: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

const GEMINI_MEDIA_ANALYSIS_FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash',
] as const;

const normalizeText = (text: string): string => text.trim().replace(/\s+/g, ' ');

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

const truncateBase64Bytes = (buffer: Buffer, maxBytes: number): Buffer =>
  buffer.length <= maxBytes ? buffer : buffer.subarray(0, maxBytes);

const parseGeminiText = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const candidates = (
    payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  ).candidates;
  const parts = candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
};

export class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'fallback' as const;

  readonly dimension = FALLBACK_DIMENSION;

  async embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return inputs.map((input) =>
      deterministicVector([input.title, input.text].filter(Boolean).join('\n'), this.dimension),
    );
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicVector(text, this.dimension));
  }

  async embedMultimodalDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return this.embedDocuments(inputs);
  }

  async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysisResult> {
    const modality = input.mimeType.startsWith('video/') ? 'video' : 'image';
    return {
      modality,
      summary: [
        `${modality.toUpperCase()} asset: ${input.fileName}`,
        `mimeType=${input.mimeType}`,
        input.cloudinaryUrl ? `url=${input.cloudinaryUrl}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      metadata: {
        mimeType: input.mimeType,
      },
    };
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

  private async normalizeVectors(vectorsPromise: Promise<number[][]>): Promise<number[][]> {
    try {
      const vectors = await vectorsPromise;
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

  async embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return this.normalizeVectors(
      this.client.embedDocuments(
        inputs.map((input) => [input.title, input.text].filter(Boolean).join('\n')),
      ),
    );
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    const maybeClient = this.client as OpenAIEmbeddings & {
      embedQuery?: (text: string) => Promise<number[]>;
    };
    if (typeof maybeClient.embedQuery === 'function') {
      return this.normalizeVectors(Promise.all(texts.map((text) => maybeClient.embedQuery!(text))));
    }
    return this.normalizeVectors(this.client.embedDocuments(texts));
  }

  async embedMultimodalDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return this.embedDocuments(inputs);
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'gemini' as const;

  readonly dimension = GEMINI_DIMENSION;

  private readonly apiKey: string;

  constructor() {
    this.apiKey = config.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is required for Gemini embeddings');
    }
  }

  private async embedWithModel(input: {
    model: string;
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
    inputs: EmbeddingDocumentInput[];
  }): Promise<number[][]> {
    const response = await fetch(GEMINI_EMBEDDING_ENDPOINT(input.model, this.apiKey), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: input.inputs.map((entry) => ({
          model: `models/${input.model}`,
          content: {
            parts: [{ text: entry.text }],
          },
          ...(entry.title ? { title: entry.title } : {}),
          taskType: input.taskType,
          outputDimensionality: this.dimension,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini embedding request failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };

    return (payload.embeddings ?? []).map((entry) => entry.values ?? []);
  }

  async embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return this.embedWithModel({
      model: config.GEMINI_EMBEDDING_MODEL,
      taskType: 'RETRIEVAL_DOCUMENT',
      inputs,
    });
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    return this.embedWithModel({
      model: config.GEMINI_EMBEDDING_MODEL,
      taskType: 'RETRIEVAL_QUERY',
      inputs: texts.map((text) => ({ text })),
    });
  }

  async embedMultimodalDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    return this.embedWithModel({
      model: config.GEMINI_MULTIMODAL_EMBEDDING_MODEL,
      taskType: 'RETRIEVAL_DOCUMENT',
      inputs,
    });
  }

  async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysisResult> {
    const modality: EmbeddingModality = input.mimeType.startsWith('video/') ? 'video' : 'image';
    const prompt =
      modality === 'video'
        ? 'Summarize this video for retrieval. Include subjects, actions, setting, visible text, and useful search keywords in a compact paragraph.'
        : 'Summarize this image for retrieval. Include main subjects, scene, visible text, and useful search keywords in a compact paragraph.';

    const inlineData = {
      mimeType: input.mimeType,
      data: truncateBase64Bytes(input.buffer, 8 * 1024 * 1024).toString('base64'),
    };

    const candidateModels = [
      config.GEMINI_MEDIA_ANALYSIS_MODEL,
      ...GEMINI_MEDIA_ANALYSIS_FALLBACK_MODELS.filter(
        (model) => model !== config.GEMINI_MEDIA_ANALYSIS_MODEL,
      ),
    ];

    let lastError = 'Gemini media analysis failed';
    for (const model of candidateModels) {
      const response = await fetch(GEMINI_GENERATE_ENDPOINT(model, this.apiKey), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }, { inlineData }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 300,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        lastError = `Gemini media analysis failed for ${model}: HTTP ${response.status}${body ? ` - ${body}` : ''}`;
        logger.warn('embedding.provider.gemini.media_analysis.failed', {
          model,
          status: response.status,
          reason: body,
        });
        if (response.status === 404) {
          continue;
        }
        throw new Error(lastError);
      }

      const payload = await response.json();
      const summary = parseGeminiText(payload);
      if (!summary) {
        lastError = `Gemini media analysis returned empty summary for ${model}`;
        continue;
      }

      return {
        modality,
        summary,
        metadata: {
          mimeType: input.mimeType,
          sourceUrl: input.cloudinaryUrl,
          mediaAnalysisModel: model,
        },
      };
    }

    throw new Error(lastError);
  }
}

export const resolveEmbeddingProvider = (): EmbeddingProvider => {
  if (config.EMBEDDING_PROVIDER === 'gemini' && config.GEMINI_API_KEY) {
    return new GeminiEmbeddingProvider();
  }

  if (config.EMBEDDING_PROVIDER === 'openai' && process.env.OPENAI_API_KEY?.trim()) {
    return new OpenAiEmbeddingProvider();
  }

  return new FallbackEmbeddingProvider();
};
