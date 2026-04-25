/**
 * Embedding provider interface.
 *
 * Three concrete implementations:
 *   - OpenAiEmbeddingProvider  — uses @ai-sdk/openai + Vercel AI SDK embedMany
 *   - GeminiEmbeddingProvider  — direct Gemini REST API (batchEmbedContents)
 *   - FallbackEmbeddingProvider — deterministic SHA-256 vectors (no network, never fails)
 *
 * The EmbeddingService wraps any provider with:
 *   - configurable batch size (default 16)
 *   - per-batch fallback on network/API failure (logs warning, returns deterministic vector)
 */

export type EmbeddingProviderName = 'openai' | 'gemini' | 'fallback';
export type EmbeddingModality = 'text' | 'image' | 'video';

export interface EmbeddingDocumentInput {
  readonly text: string;
  readonly title?: string;
  /**
   * Raw media bytes for native multimodal embedding (gemini-embedding-2-preview only).
   * When present, the content is embedded as both inline_data + text parts.
   * Truncated to 8 MB before transmission.
   */
  readonly inlineData?: { readonly mimeType: string; readonly buffer: Buffer };
}

export interface MediaAnalysisInput {
  readonly mimeType: string;
  readonly fileName: string;
  /** Raw bytes of the media file (images / short video clips). Max 8 MB sent to Gemini. */
  readonly buffer: Buffer;
  readonly cloudinaryUrl?: string;
}

export interface MediaAnalysisResult {
  readonly modality: EmbeddingModality;
  /** LLM-generated retrieval summary of the media. */
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
}

export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderName;
  /** Dimensionality of text embedding vectors produced by this provider. */
  readonly textDimension: number;
  /** Dimensionality of multimodal embedding vectors (may differ from textDimension). */
  readonly multimodalDimension: number;

  /**
   * Embed documents for storage/indexing (RETRIEVAL_DOCUMENT task type).
   */
  embedDocuments(inputs: EmbeddingDocumentInput[]): Promise<number[][]>;

  /**
   * Embed queries for search (RETRIEVAL_QUERY task type).
   */
  embedQueries(texts: string[]): Promise<number[][]>;

  /**
   * Embed documents using the multimodal model (text-only content, multimodal-capable vector).
   * Falls back to embedDocuments if not supported by the provider.
   */
  embedMultimodal?(inputs: EmbeddingDocumentInput[]): Promise<number[][]>;

  /**
   * Analyse a media file and return a retrieval summary.
   * Only implemented by GeminiEmbeddingProvider (and FallbackEmbeddingProvider for test stubs).
   */
  analyzeMedia?(input: MediaAnalysisInput): Promise<MediaAnalysisResult>;
}

/** Augmented MediaAnalysisResult that includes the text embedding of the summary. */
export interface EmbeddedMediaSummary extends MediaAnalysisResult {
  readonly embedding: number[];
}
