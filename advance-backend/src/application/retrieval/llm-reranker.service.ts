/**
 * Groq-backed listwise reranker.
 * Scores each chunk 0-10 for relevance to the query, then sorts descending.
 * Falls back to score-sort on any error (including missing GROQ_API_KEY).
 */
import Groq from 'groq-sdk';
import type { VectorSearchResult } from '../../infrastructure/ai/vector/types';
import type { Logger } from '../../shared/logger';

export interface RankedChunk {
  chunk:        VectorSearchResult;
  rerankerScore: number;
}

export class LlmRerankerService {
  private readonly client: Groq | null;
  private readonly model = 'llama-3.1-8b-instant';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly logger: Logger,
    private readonly threshold = 3,
  ) {
    this.client = apiKey ? new Groq({ apiKey }) : null;
  }

  async rerank(query: string, chunks: VectorSearchResult[]): Promise<RankedChunk[]> {
    if (!this.client || chunks.length === 0) {
      return this.scoreSortFallback(chunks);
    }

    // Build listwise prompt
    const chunkList = chunks.map((c, i) => {
      const text = (c.payload['rawChunkText'] ?? c.payload['text'] ?? c.payload['chunkText'] ?? '') as string;
      return `[${i + 1}] ${text.slice(0, 600)}`;
    }).join('\n\n');

    const systemPrompt = [
      `You are a retrieval quality judge. Given a user query and a list of document chunks,`,
      `score each chunk 0-10 for relevance (10=perfectly relevant, 0=irrelevant).`,
      `Reply ONLY with a JSON array of numbers, one per chunk, e.g.: [8,2,9,1,7]`,
    ].join(' ');

    const userPrompt = `Query: "${query}"\n\nChunks:\n${chunkList}\n\nJSON scores:`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        max_tokens: 128,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? '[]';
      const scores = JSON.parse(raw) as number[];

      if (!Array.isArray(scores) || scores.length !== chunks.length) {
        throw new Error('Invalid scores array');
      }

      return chunks
        .map((chunk, i) => ({ chunk, rerankerScore: scores[i] ?? 0 }))
        .filter(r => r.rerankerScore >= this.threshold)
        .sort((a, b) => b.rerankerScore - a.rerankerScore);
    } catch (e) {
      this.logger.warn('reranker.groq_failed', { error: String(e) });
      return this.scoreSortFallback(chunks);
    }
  }

  private scoreSortFallback(chunks: VectorSearchResult[]): RankedChunk[] {
    return chunks
      .map(chunk => ({ chunk, rerankerScore: chunk.score * 10 }))
      .sort((a, b) => b.rerankerScore - a.rerankerScore);
  }
}
