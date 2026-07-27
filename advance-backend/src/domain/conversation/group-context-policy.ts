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
  MIN_MESSAGES_FOR_LLM_SUMMARY: 16,

  // ─── Multimodal image budget ───────────────────────────────────────────────
  /** Approximate token cost per image in low-res mode (vision models). */
  IMAGE_TOKEN_COST: 850,
  /** Max images to include as multimodal parts within the transcript budget. */
  MAX_INLINE_IMAGES: 8,
  /** Token budget for a single large document excerpt (smart extraction). */
  DOC_EXCERPT_TOKEN_BUDGET: 5_000,
} as const;
