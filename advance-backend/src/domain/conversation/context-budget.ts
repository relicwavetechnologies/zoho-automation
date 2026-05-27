/** Global context budget for the Brain's LLM call. */
export const CONTEXT_BUDGET = {
  TOTAL_TARGET: 150_000,
  SYSTEM_PROMPT_MAX: 8_000,
  CONVERSATION_SUMMARY_MAX: 12_000,
  MEMORY_CONTEXT_MAX: 4_000,
  GROUP_CONTEXT_MAX: 20_000,
  CURRENT_MESSAGE_MAX: 5_000,
  OUTPUT_BUFFER: 21_000,
} as const;

export interface ContextBudgetAllocation {
  readonly systemPromptTokens: number;
  readonly summaryTokens: number;
  readonly memoryTokens: number;
  readonly groupContextTokens: number;
  readonly historyTokens: number;
  readonly currentMessageTokens: number;
  readonly totalTokens: number;
  readonly trimActions: readonly string[];
}
