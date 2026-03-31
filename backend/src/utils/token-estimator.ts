import type { AiModelCatalogEntry } from '../company/ai-models/catalog';

/**
 * Fast, zero-dependency token estimation.
 * Uses ~4 chars/token heuristic — safe for context budget decisions.
 * (Exact tiktoken can upgrade this later without changing the API.)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.2);
}

export function estimateMessageTokens(
  messages: Array<{ content: unknown }>,
): number {
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    return sum + estimateTokens(content) + 4;
  }, 0);
}

export function estimatePayloadTokens(payload: {
  systemPrompt: string;
  messages: Array<{ content: unknown }>;
  extraContext?: string;
}): number {
  return (
    estimateTokens(payload.systemPrompt)
    + estimateMessageTokens(payload.messages)
    + estimateTokens(payload.extraContext ?? '')
  );
}

/**
 * Returns the usable token budget for conversation history.
 * Subtract outputReserveTokens to leave headroom for generation.
 */
export function getTokenBudget(entry: AiModelCatalogEntry): number {
  return entry.maxContextTokens - entry.outputReserveTokens;
}

/**
 * Threshold (fraction of budget) at which context compaction is triggered.
 * 0.70 = compact when conversation context exceeds 70% of the model's token budget.
 */
export const COMPACTION_THRESHOLD = 0.70;

/**
 * Check if the given context string is approaching the model's context window limit.
 */
export function isContextNearLimit(contextText: string, entry: AiModelCatalogEntry): boolean {
  const budget = getTokenBudget(entry);
  const used = estimateTokens(contextText);
  return used / budget >= COMPACTION_THRESHOLD;
}

/**
 * Extract actual token counts reported by the AI SDK response usage object.
 * Falls back to zero if the model does not report usage.
 */
export function extractActualTokenUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
} {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: (typeof usage['promptTokens'] === 'number' ? usage['promptTokens'] : 0) as number,
    outputTokens: (typeof usage['completionTokens'] === 'number' ? usage['completionTokens'] : 0) as number,
  };
}
