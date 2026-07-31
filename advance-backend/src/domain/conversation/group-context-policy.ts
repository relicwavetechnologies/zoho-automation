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

  // ─── Isolated Pi runtime budgets ───────────────────────────────────────────
  // The room window reaches an isolated Pi container inside the controller's
  // JSON request body, which is capped at 64 KB. These budgets are deliberately
  // far smaller than the in-process ones above so the transcript, the rolling
  // summary, the current ask, and the attachment manifest all fit with room to
  // spare — a rejected body would fail the whole turn, not just shorten it.
  // Sized so transcript + summary + framing land under PI_CONTEXT_MAX_BYTES for
  // single-byte text, leaving the byte cap as a guard for scripts that cost more
  // per character rather than the ordinary path.
  /** Approximate token budget for the transcript sent to an isolated Pi run. */
  PI_TRANSCRIPT_TOKEN_BUDGET: 5_000,
  /** Approximate token budget for the rolling summary sent to an isolated Pi run. */
  PI_SUMMARY_TOKEN_BUDGET: 1_200,
  /**
   * Hard ceiling on the rendered block, enforced after formatting in bytes
   * rather than estimated tokens. The token budgets above are estimates; this
   * is the guarantee.
   */
  PI_CONTEXT_MAX_BYTES: 32 * 1024,

  // ─── Multimodal image budget ───────────────────────────────────────────────
  /** Approximate token cost per image in low-res mode (vision models). */
  IMAGE_TOKEN_COST: 850,
  /** Max images to include as multimodal parts within the transcript budget. */
  MAX_INLINE_IMAGES: 8,
  /** Token budget for a single large document excerpt (smart extraction). */
  DOC_EXCERPT_TOKEN_BUDGET: 5_000,
} as const;
