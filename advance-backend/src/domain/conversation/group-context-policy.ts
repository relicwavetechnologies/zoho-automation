export const GROUP_CONTEXT_POLICY = {
  /**
   * Approximate token budget for raw room transcript injected into prompts.
   * This is intentionally separate from the model's max context window: a large
   * window still has latency and attention-quality cost.
   */
  RAW_TRANSCRIPT_TOKEN_BUDGET: 20_000,
  /** Approximate token budget for formatted rolling summary injected into prompts. */
  SUMMARY_CONTEXT_TOKEN_BUDGET: 15_000,
  /**
   * Approximate token budget for recent group messages kept before older
   * messages roll into summaryJson.
   */
  RETAINED_MESSAGE_TOKEN_BUDGET: 20_000,
  /** Backward-compatible alias for retention partitioning. */
  TOKEN_BUDGET: 20_000,
  MIN_MESSAGES: 40,
  MAX_MESSAGES: 200,
  SUMMARY_REFRESH_DELTA: 6,
  MIN_MESSAGES_FOR_LLM_SUMMARY: 16,
} as const;
