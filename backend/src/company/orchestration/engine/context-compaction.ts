import type { ModelMessage } from 'ai';

import { estimateMessageTokens, estimatePayloadTokens, estimateTokens } from '../../../utils/token-estimator';

export type RetrievalSnippet = {
  source: string;
  text: string;
  score: number;
};

export type ConversationRetrievalItem = {
  text: string;
  score: number;
};

export type CompactionInput = {
  systemPromptCore: string;
  toolDefinitions: string;
  taskState: string;
  behaviorProfileContext: string;
  threadSummary: string;
  retrievalSnippets: RetrievalSnippet[];
  memoryFacts: string[];
  durableMemoryText: string;
  recentMessages: ModelMessage[];
  olderMessages: ModelMessage[];
  conversationRetrieval: ConversationRetrievalItem[];
};

export type CompactionOutput = {
  behaviorProfileContext: string;
  threadSummary: string;
  retrievalSnippets: RetrievalSnippet[];
  memoryFacts: string[];
  durableMemoryText: string;
  recentMessages: ModelMessage[];
  olderMessages: ModelMessage[];
  conversationRetrieval: ConversationRetrievalItem[];
  wasCompacted: boolean;
  finalEstimatedTokens: number;
  compactionLog: string[];
};

export const GEMINI_HARD_CONTEXT_LIMIT = 1_048_576;
export const GEMINI_OUTPUT_TOKEN_RESERVE = 8_192;
export const GEMINI_SAFETY_TOKEN_MARGIN = 10_000;
export const FULL_PROMPT_COMPACTION_USABLE_BUDGET =
  GEMINI_HARD_CONTEXT_LIMIT - GEMINI_OUTPUT_TOKEN_RESERVE - GEMINI_SAFETY_TOKEN_MARGIN;
export const PROTECTED_RECENT_MESSAGE_COUNT = 12;

const truncateToTokenBudget = (text: string, maxTokens: number): string => {
  const normalized = text.trim();
  if (!normalized) return '';
  const maxChars = Math.floor(maxTokens * 3.2);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)} [truncated]`;
};

export const runLayeredCompaction = (input: CompactionInput): CompactionOutput => {
  const log: string[] = [];
  let behaviorProfileContext = input.behaviorProfileContext;
  let threadSummary = input.threadSummary;
  let retrievalSnippets = [...input.retrievalSnippets];
  let memoryFacts = [...input.memoryFacts];
  let durableMemoryText = input.durableMemoryText;
  let olderMessages = [...input.olderMessages];
  let conversationRetrieval = [...input.conversationRetrieval];

  const fixedCost =
    estimateTokens(input.systemPromptCore)
    + estimateTokens(input.toolDefinitions)
    + estimateTokens(input.taskState)
    + estimateMessageTokens(input.recentMessages);

  const computeVariableCost = (): number =>
    estimateTokens(behaviorProfileContext)
    + estimateTokens(threadSummary)
    + retrievalSnippets.reduce((sum, snippet) => sum + estimateTokens(snippet.text), 0)
    + memoryFacts.reduce((sum, fact) => sum + estimateTokens(fact), 0)
    + estimateTokens(durableMemoryText)
    + estimateMessageTokens(olderMessages)
    + conversationRetrieval.reduce((sum, item) => sum + estimateTokens(item.text), 0);

  const totalCost = (): number => fixedCost + computeVariableCost();

  if (totalCost() <= FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
    return {
      behaviorProfileContext,
      threadSummary,
      retrievalSnippets,
      memoryFacts,
      durableMemoryText,
      recentMessages: input.recentMessages,
      olderMessages,
      conversationRetrieval,
      wasCompacted: false,
      finalEstimatedTokens: totalCost(),
      compactionLog: [],
    };
  }

  while (olderMessages.length > 0 && totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
    const dropped = olderMessages.shift();
    log.push(`Dropped oldest message: role=${dropped?.role ?? 'unknown'}`);
  }

  if (totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
    conversationRetrieval.sort((a, b) => a.score - b.score);
    while (conversationRetrieval.length > 0 && totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
      const dropped = conversationRetrieval.shift();
      log.push(`Dropped conversation retrieval item, score=${(dropped?.score ?? 0).toFixed(3)}`);
    }
  }

  if (totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
    retrievalSnippets.sort((a, b) => a.score - b.score);
    for (let index = 0; index < retrievalSnippets.length && totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET; index += 1) {
      const original = retrievalSnippets[index]!.text;
      retrievalSnippets[index] = {
        ...retrievalSnippets[index]!,
        text: truncateToTokenBudget(original, 300),
      };
      log.push(`Truncated retrieval snippet from ${estimateTokens(original)} to <=300 tokens, source=${retrievalSnippets[index]!.source}`);
    }
  }

  if (totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
    memoryFacts = memoryFacts.map((fact, index) => {
      if (totalCost() <= FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
        return fact;
      }
      log.push(`Truncated memory fact ${index}`);
      return truncateToTokenBudget(fact, 100);
    });
  }

  if (totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET && behaviorProfileContext.trim()) {
    const original = behaviorProfileContext;
    behaviorProfileContext = truncateToTokenBudget(behaviorProfileContext, 300);
    log.push(`Truncated behavior profile from ${estimateTokens(original)} to <=300 tokens`);
  }

  if (totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET && durableMemoryText.trim()) {
    const original = durableMemoryText;
    durableMemoryText = truncateToTokenBudget(durableMemoryText, 500);
    log.push(`Truncated durable memory from ${estimateTokens(original)} to <=500 tokens`);
  }

  if (totalCost() > FULL_PROMPT_COMPACTION_USABLE_BUDGET && threadSummary.trim()) {
    const original = threadSummary;
    threadSummary = truncateToTokenBudget(threadSummary, 400);
    log.push(`Truncated thread summary from ${estimateTokens(original)} to <=400 tokens`);
  }

  const finalEstimatedTokens = totalCost();
  if (finalEstimatedTokens > FULL_PROMPT_COMPACTION_USABLE_BUDGET) {
    log.push(`WARN: Still over budget after compaction. Estimated=${finalEstimatedTokens}`);
  }

  return {
    behaviorProfileContext,
    threadSummary,
    retrievalSnippets,
    memoryFacts,
    durableMemoryText,
    recentMessages: input.recentMessages,
    olderMessages,
    conversationRetrieval,
    wasCompacted: true,
    finalEstimatedTokens,
    compactionLog: log,
  };
};

export const estimateFinalPromptTokens = (input: {
  systemPrompt: string;
  messages: ModelMessage[];
  extraContext?: string;
}): number => estimatePayloadTokens(input);
