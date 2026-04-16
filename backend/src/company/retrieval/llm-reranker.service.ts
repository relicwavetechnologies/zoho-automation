/**
 * LLM Reranker Service
 *
 * Uses Groq llama-3.1-8b-instant for listwise reranking (free tier).
 * Falls back to score sort if GROQ_API_KEY is missing or Groq times out.
 *
 * Only triggered when:
 *   - results >= 4 AND tier is STANDARD or COMPLEX
 *   - tier is COMPLEX regardless of result count
 *
 * Never triggered for:
 *   - Exact filename fast path results
 *   - Contact lookups
 *   - SIMPLE tier
 *   - Single result returns
 */

import config from '../../config';
import { logger } from '../../utils/logger';
import { withProviderRetry } from '../../utils/provider-retry';

const RERANKER_MODEL = 'llama-3.1-8b-instant';
const RERANKER_TIMEOUT_MS = 6_000;
const RERANKER_MAX_TOKENS = 800;

export type RerankCandidate = {
  id: string;
  content: string;
  score: number;
};

export type RerankResult = {
  id: string;
  score: number;
  reason: string;
};

export type RerankerOutput = {
  ranked: RerankResult[];
  method: 'groq_listwise' | 'score_sort';
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
};

const RERANKER_SYSTEM_PROMPT = `You are a search result ranker. Given a user query and a list of search results, score each result for relevance.

Scoring rubric:
10 = exact answer or perfect match
7-9 = highly relevant, directly addresses the query
4-6 = partially relevant, related but incomplete
1-3 = loosely related, tangential
0 = irrelevant

Rules:
- Think carefully before scoring. Consider: filename match, content relevance, recency, specificity.
- For filename queries: exact or fuzzy filename matches score highest.
- For conversation recall: recency and topic match score highest.
- For financial records: specificity of entity match scores highest.
- Return ONLY valid JSON array, no other text, no markdown, no explanation outside the array.

Format: [{"id": "...", "score": 8, "reason": "one line reason"}]`;

const buildRerankPrompt = (query: string, candidates: RerankCandidate[]): string => {
  const candidateList = candidates
    .map((c, i) => `[${i + 1}] id="${c.id}"\n${c.content.slice(0, 300)}`)
    .join('\n\n');

  return `Query: "${query}"\n\nResults to rank:\n${candidateList}`;
};

const parseRerankResponse = (text: string): RerankResult[] | null => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter((entry) => typeof entry?.id === 'string' && typeof entry?.score === 'number')
      .map((entry) => ({
        id: String(entry.id),
        score: Math.max(0, Math.min(10, Number(entry.score))) / 10, // normalize to 0-1
        reason: typeof entry.reason === 'string' ? entry.reason : '',
      }));
  } catch {
    return null;
  }
};

const scoreSortFallback = (candidates: RerankCandidate[]): RerankResult[] =>
  [...candidates]
    .sort((a, b) => b.score - a.score)
    .map((c) => ({
      id: c.id,
      score: c.score,
      reason: 'score_sort_fallback',
    }));

/**
 * Rerank candidates using Groq listwise LLM reranking.
 * Falls back to score sort on any failure.
 */
export const rerankCandidates = async (
  query: string,
  candidates: RerankCandidate[],
  options?: {
    timeoutMs?: number;
  },
): Promise<RerankerOutput> => {
  const startMs = Date.now();

  if (candidates.length === 0) {
    return {
      ranked: [],
      method: 'score_sort',
      durationMs: 0,
      skipped: true,
      skipReason: 'no_candidates',
    };
  }

  if (!config.GROQ_API_KEY?.trim()) {
    logger.warn('llm_reranker.groq_key_missing', { query: query.slice(0, 80) });
    return {
      ranked: scoreSortFallback(candidates),
      method: 'score_sort',
      durationMs: Date.now() - startMs,
      skipped: false,
      skipReason: 'groq_key_missing',
    };
  }

  const timeoutMs = options?.timeoutMs ?? RERANKER_TIMEOUT_MS;

  try {
    const response = await withProviderRetry('groq', async () => {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: RERANKER_MODEL,
          temperature: 0,
          max_tokens: RERANKER_MAX_TOKENS,
          messages: [
            { role: 'system', content: RERANKER_SYSTEM_PROMPT },
            { role: 'user', content: buildRerankPrompt(query, candidates) },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const err: Error & { status?: number } = new Error(`llm_reranker_http_${res.status}`);
        err.status = res.status;
        throw err;
      }

      return res;
    });

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
    const parsed = parseRerankResponse(content);

    if (!parsed || parsed.length === 0) {
      throw new Error('llm_reranker_empty_parse');
    }

    // Merge: apply rerank scores back to original candidates by id
    const scoreMap = new Map(parsed.map((r) => [r.id, r]));
    const merged: RerankResult[] = candidates.map((c) => {
      const reranked = scoreMap.get(c.id);
      return reranked ?? { id: c.id, score: c.score, reason: 'not_in_rerank_response' };
    });

    const ranked = merged.sort((a, b) => b.score - a.score);

    return {
      ranked,
      method: 'groq_listwise',
      durationMs: Date.now() - startMs,
      skipped: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('llm_reranker.fallback_score_sort', {
      query: query.slice(0, 80),
      candidateCount: candidates.length,
      error: message,
    });

    return {
      ranked: scoreSortFallback(candidates),
      method: 'score_sort',
      durationMs: Date.now() - startMs,
      skipped: false,
      skipReason: `groq_failed: ${message}`,
    };
  }
};

/**
 * Decide whether to rerank based on tier and result count.
 */
export const shouldRerank = (input: {
  tier: 'simple' | 'standard' | 'complex';
  resultCount: number;
  fastPathUsed: boolean;
}): { rerank: boolean; reason: string } => {
  if (input.fastPathUsed) {
    return { rerank: false, reason: 'fast_path_exact_match' };
  }
  if (input.tier === 'simple') {
    return { rerank: false, reason: 'simple_tier' };
  }
  if (input.tier === 'complex') {
    return { rerank: true, reason: 'complex_tier_always_rerank' };
  }
  // standard tier
  if (input.resultCount < 4) {
    return { rerank: false, reason: 'too_few_results' };
  }
  return { rerank: true, reason: 'standard_tier_sufficient_results' };
};

export const llmRerankerService = {
  rerank: rerankCandidates,
  shouldRerank,
};