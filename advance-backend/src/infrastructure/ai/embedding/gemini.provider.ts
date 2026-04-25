/**
 * Gemini embedding provider — direct REST API (no LangChain, no SDK dependency).
 *
 * Text embedding:     POST /v1beta/models/{GEMINI_EMBEDDING_MODEL}:batchEmbedContents
 * Multimodal embed:   POST /v1beta/models/{GEMINI_MULTIMODAL_EMBEDDING_MODEL}:batchEmbedContents
 * Media analysis:     POST /v1beta/models/{gemini-2.5-flash|fallback...}:generateContent
 *
 * Both embedding models output 3072-dimensional vectors by default.
 *
 * Task types used:
 *   embedDocuments → RETRIEVAL_DOCUMENT
 *   embedQueries   → RETRIEVAL_QUERY
 */

import type {
  EmbeddingDocumentInput,
  EmbeddingModality,
  EmbeddingProvider,
  MediaAnalysisInput,
  MediaAnalysisResult,
} from './types';

export const GEMINI_DIMENSION = 3072;

// ─── Gemini API endpoint builders ─────────────────────────────────────────────

const BATCH_EMBED_URL = (model: string, apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;

const GENERATE_URL = (model: string, apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

// Fallback chain for media analysis (newest to most-available)
const MEDIA_ANALYSIS_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash',
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncateBuffer(buf: Buffer, maxBytes: number): Buffer {
  return buf.length <= maxBytes ? buf : buf.subarray(0, maxBytes);
}

function parseGeminiGenerateText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = (
    payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  ).candidates;
  return (candidates?.[0]?.content?.parts ?? [])
    .map(p => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n')
    .trim();
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'gemini' as const;
  readonly textDimension = GEMINI_DIMENSION;
  readonly multimodalDimension = GEMINI_DIMENSION;

  private readonly apiKey: string;
  private readonly textModel: string;
  private readonly multimodalModel: string;

  constructor(opts: {
    apiKey: string;
    textModel: string;       // GEMINI_EMBEDDING_MODEL
    multimodalModel: string; // GEMINI_MULTIMODAL_EMBEDDING_MODEL
  }) {
    if (!opts.apiKey) throw new Error('GEMINI_API_KEY is required for GeminiEmbeddingProvider');
    this.apiKey = opts.apiKey;
    this.textModel = opts.textModel;
    this.multimodalModel = opts.multimodalModel;
  }

  // ── Core batch embed ─────────────────────────────────────────────────────

  private async batchEmbed(opts: {
    model: string;
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
    inputs: EmbeddingDocumentInput[];
  }): Promise<number[][]> {
    const res = await fetch(BATCH_EMBED_URL(opts.model, this.apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: opts.inputs.map(entry => {
          // Build content parts: inline image bytes first (when present), then text.
          // gemini-embedding-2-preview accepts both inline_data + text in a single request.
          const parts: object[] = [];
          if (entry.inlineData) {
            parts.push({
              inline_data: {
                mime_type: entry.inlineData.mimeType,
                data: truncateBuffer(entry.inlineData.buffer, 8 * 1024 * 1024).toString('base64'),
              },
            });
          }
          if (entry.text) parts.push({ text: entry.text });
          return {
            model:   `models/${opts.model}`,
            content: { parts },
            ...(entry.title ? { title: entry.title } : {}),
            taskType: opts.taskType,
            outputDimensionality: this.textDimension,
          };
        }),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Gemini batchEmbedContents failed for ${opts.model}: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
      );
    }

    const payload = await res.json() as { embeddings?: Array<{ values?: number[] }> };
    return (payload.embeddings ?? []).map(e => e.values ?? []);
  }

  // ── EmbeddingProvider interface ──────────────────────────────────────────

  async embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    return this.batchEmbed({ model: this.textModel, taskType: 'RETRIEVAL_DOCUMENT', inputs });
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.batchEmbed({
      model: this.textModel,
      taskType: 'RETRIEVAL_QUERY',
      inputs: texts.map(text => ({ text })),
    });
  }

  async embedMultimodal(inputs: EmbeddingDocumentInput[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    return this.batchEmbed({
      model: this.multimodalModel,
      taskType: 'RETRIEVAL_DOCUMENT',
      inputs,
    });
  }

  // ── Media analysis (Gemini generateContent) ──────────────────────────────

  async analyzeMedia(input: MediaAnalysisInput): Promise<MediaAnalysisResult> {
    const modality: EmbeddingModality = input.mimeType.startsWith('video/') ? 'video' : 'image';
    const prompt =
      modality === 'video'
        ? 'Summarize this video for retrieval. Include subjects, actions, setting, visible text, and useful search keywords in a compact paragraph.'
        : 'Summarize this image for retrieval. Include main subjects, scene, visible text, and useful search keywords in a compact paragraph.';

    const inlineData = {
      mimeType: input.mimeType,
      data: truncateBuffer(input.buffer, 8 * 1024 * 1024).toString('base64'),
    };

    let lastError = 'Gemini media analysis failed (no models tried)';

    for (const model of MEDIA_ANALYSIS_MODELS) {
      const res = await fetch(GENERATE_URL(model, this.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: prompt }, { inlineData }],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastError = `Gemini media analysis (${model}): HTTP ${res.status}${body ? ` — ${body}` : ''}`;
        if (res.status === 404) continue; // model not available — try next
        throw new Error(lastError);       // hard error from Gemini
      }

      const payload = await res.json();
      const summary = parseGeminiGenerateText(payload);

      if (!summary) {
        lastError = `Gemini media analysis (${model}): empty summary`;
        continue; // try next model
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
