// DEPRECATED: Observational Memory (mastra.instance.ts) now handles context
// compression. This compactor is kept as a fallback and will be removed once
// OM has been validated in production.

import { logger } from '../../utils/logger';
import { estimateTokens, COMPACTION_THRESHOLD } from '../../utils/token-estimator';
import type { AiModelCatalogEntry } from '../../company/ai-models/catalog';
import { resolveMastraLanguageModel } from '../../company/integrations/mastra/mastra-model-control';

type ConversationMessage = { role: 'user' | 'assistant'; content: string };

type CompactResult = {
  messages: ConversationMessage[];
  wasCompacted: boolean;
  /** Prepend this text block to the objective if compaction occurred */
  compactedContextBlock: string;
};

// The fast, cheap model used for compaction summarization
const COMPACTION_MODEL_TARGET = 'mastra.ack' as const;

/** Number of most-recent messages to always keep verbatim */
const RECENT_VERBATIM_COUNT = 15;

/**
 * Builds the full context string from all messages, for token estimation.
 */
function buildContextString(messages: ConversationMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/**
 * Call a lightweight model to compress earlier conversation history into a summary.
 * Returns the summary string, or null on failure.
 */
async function compressHistory(messages: ConversationMessage[]): Promise<string | null> {
  try {
    const historyText = buildContextString(messages);
    const compactionPrompt = [
      'You are a context compressor for an AI assistant system.',
      'Summarize the following conversation history into ONE concise paragraph.',
      'Preserve: key decisions made, entities/names/values referenced, tasks completed, and any open questions.',
      'Output ONLY the summary paragraph. Do NOT include any preamble or explanation.',
      '',
      '--- History to compress ---',
      historyText,
      '--- End history ---',
    ].join('\n');

    const { generateText } = require('ai');
    const model = await resolveMastraLanguageModel(COMPACTION_MODEL_TARGET);

    const { text } = await generateText({
      model,
      prompt: compactionPrompt,
      maxTokens: 512,
    });

    return text?.trim() || null;
  } catch (err) {
    logger.warn('context.compactor.compression.failed', { error: err });
    return null;
  }
}

/**
 * Core compaction function.
 *
 * - If conversation context is within the safe token budget: returns as-is.
 * - If context exceeds COMPACTION_THRESHOLD of the model's token budget:
 *   1. Keeps the last RECENT_VERBATIM_COUNT messages verbatim.
 *   2. Compresses the older messages using a lightweight AI call.
 *   3. Returns a structured result with the compacted history.
 *   4. On compaction failure: gracefully falls back to just last 15 messages.
 *
 * Non-destructive — original DB messages are never modified.
 */
export async function maybeCompactHistory(
  history: ConversationMessage[],
  newMessage: string,
  catalogEntry: AiModelCatalogEntry,
): Promise<CompactResult> {
  if (history.length <= RECENT_VERBATIM_COUNT) {
    return { messages: history, wasCompacted: false, compactedContextBlock: '' };
  }

  const budget = catalogEntry.maxContextTokens - catalogEntry.outputReserveTokens;
  const totalTokens = estimateTokens(buildContextString(history)) + estimateTokens(newMessage);

  if (totalTokens / budget < COMPACTION_THRESHOLD) {
    return { messages: history, wasCompacted: false, compactedContextBlock: '' };
  }

  logger.info('context.compactor.triggered', {
    historyMessages: history.length,
    estimatedTokens: totalTokens,
    budget,
    thresholdPct: COMPACTION_THRESHOLD,
  });

  const recentMessages = history.slice(-RECENT_VERBATIM_COUNT);
  const oldMessages = history.slice(0, -RECENT_VERBATIM_COUNT);

  const summary = await compressHistory(oldMessages);

  if (!summary) {
    // Graceful fallback — just use last 15 messages, no compaction
    logger.warn('context.compactor.fallback', { reason: 'compression returned empty' });
    return { messages: recentMessages, wasCompacted: false, compactedContextBlock: '' };
  }

  const compactedContextBlock = [
    '--- COMPRESSED CONVERSATION CONTEXT ---',
    '(Earlier messages have been summarized to stay within context window limits.)',
    summary,
    '--- END COMPRESSED CONTEXT ---',
  ].join('\n');

  logger.info('context.compactor.success', {
    oldMessages: oldMessages.length,
    recentKept: recentMessages.length,
    summaryTokens: estimateTokens(summary),
  });

  return {
    messages: recentMessages,
    wasCompacted: true,
    compactedContextBlock,
  };
}
