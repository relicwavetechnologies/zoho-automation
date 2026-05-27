import type { Turn } from '../../../domain/conversation/turn';
import { CONTEXT_BUDGET, type ContextBudgetAllocation } from '../../../domain/conversation/context-budget';

function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ContextComponents {
  systemPrompt: string;
  conversationSummary?: string;
  memoryContext?: string;
  groupContext?: string;
  historyTurns: readonly Turn[];
  currentMessage: string;
}

export interface BudgetedContext {
  systemPrompt: string;
  conversationSummary?: string;
  memoryContext?: string;
  groupContext?: string;
  historyTurns: Turn[];
  currentMessage: string;
  allocation: ContextBudgetAllocation;
}

export function enforceContextBudget(
  components: ContextComponents,
): BudgetedContext {
  const trimActions: string[] = [];
  const { TOTAL_TARGET, SYSTEM_PROMPT_MAX, CONVERSATION_SUMMARY_MAX, MEMORY_CONTEXT_MAX, GROUP_CONTEXT_MAX, CURRENT_MESSAGE_MAX, OUTPUT_BUFFER } = CONTEXT_BUDGET;

  let systemPrompt = components.systemPrompt;
  let systemPromptTokens = estimateTokens(systemPrompt);
  if (systemPromptTokens > SYSTEM_PROMPT_MAX) {
    systemPrompt = systemPrompt.slice(0, SYSTEM_PROMPT_MAX * 4);
    systemPromptTokens = SYSTEM_PROMPT_MAX;
    trimActions.push(`system_prompt capped at ${SYSTEM_PROMPT_MAX}`);
  }

  let currentMessage = components.currentMessage;
  let currentMessageTokens = estimateTokens(currentMessage);
  if (currentMessageTokens > CURRENT_MESSAGE_MAX) {
    currentMessage = currentMessage.slice(0, CURRENT_MESSAGE_MAX * 4);
    currentMessageTokens = CURRENT_MESSAGE_MAX;
    trimActions.push(`current_message capped at ${CURRENT_MESSAGE_MAX}`);
  }

  let remaining = TOTAL_TARGET - systemPromptTokens - currentMessageTokens - OUTPUT_BUFFER;

  let conversationSummary = components.conversationSummary;
  let summaryTokens = estimateTokens(conversationSummary);
  if (summaryTokens > CONVERSATION_SUMMARY_MAX) {
    conversationSummary = conversationSummary!.slice(0, CONVERSATION_SUMMARY_MAX * 4);
    summaryTokens = CONVERSATION_SUMMARY_MAX;
    trimActions.push(`conversation_summary capped at ${CONVERSATION_SUMMARY_MAX}`);
  }
  remaining -= summaryTokens;

  let memoryContext = components.memoryContext;
  let memoryTokens = estimateTokens(memoryContext);
  if (memoryTokens > MEMORY_CONTEXT_MAX) {
    memoryContext = memoryContext!.slice(0, MEMORY_CONTEXT_MAX * 4);
    memoryTokens = MEMORY_CONTEXT_MAX;
    trimActions.push(`memory_context capped at ${MEMORY_CONTEXT_MAX}`);
  }
  remaining -= memoryTokens;

  let groupContext = components.groupContext;
  let groupContextTokens = estimateTokens(groupContext);
  if (groupContextTokens > GROUP_CONTEXT_MAX) {
    groupContext = groupContext!.slice(0, GROUP_CONTEXT_MAX * 4);
    groupContextTokens = GROUP_CONTEXT_MAX;
    trimActions.push(`group_context capped at ${GROUP_CONTEXT_MAX}`);
  }
  remaining -= groupContextTokens;

  const historyBudget = Math.max(0, remaining);
  let historyTokens = 0;
  const historyTurns: Turn[] = [];
  for (let i = components.historyTurns.length - 1; i >= 0; i--) {
    const t = components.historyTurns[i]!;
    const tokens = estimateTokens(t.content);
    if (historyTokens + tokens > historyBudget) {
      trimActions.push(`history trimmed from ${components.historyTurns.length} to ${historyTurns.length} turns (budget ${historyBudget})`);
      break;
    }
    historyTurns.unshift(t);
    historyTokens += tokens;
  }

  const totalTokens = systemPromptTokens + summaryTokens + memoryTokens + groupContextTokens + historyTokens + currentMessageTokens;

  if (totalTokens > TOTAL_TARGET - OUTPUT_BUFFER && memoryTokens > 0) {
    memoryContext = undefined;
    trimActions.push('memory_context dropped (emergency trim)');
    memoryTokens = 0;
  }

  return {
    systemPrompt,
    ...(conversationSummary ? { conversationSummary } : {}),
    ...(memoryContext ? { memoryContext } : {}),
    ...(groupContext ? { groupContext } : {}),
    historyTurns,
    currentMessage,
    allocation: {
      systemPromptTokens,
      summaryTokens,
      memoryTokens,
      groupContextTokens,
      historyTokens,
      currentMessageTokens,
      totalTokens: systemPromptTokens + summaryTokens + memoryTokens + groupContextTokens + historyTokens + currentMessageTokens,
      trimActions,
    },
  };
}
