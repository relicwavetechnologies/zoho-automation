/** Rules for conversation history windowing and poison filtering. */
export const HISTORY_POLICY = {
  /** Max turns to include (user + assistant pairs) */
  MAX_TURNS: 30,
  /** Approximate max token budget for history */
  MAX_TOKEN_BUDGET: 24_000,
  /** Most recent turns kept verbatim. */
  FULL_TIER_COUNT: 4,
  /** Turns before the full tier kept in condensed form. */
  CONDENSED_TIER_COUNT: 6,
  /** Regex patterns that indicate a poisoned turn (agent confused by past failures) */
  POISON_PATTERNS: [
    /permission denied for tool/i,
    /i (?:cannot|can't|am unable to) (?:create|access|use|invoke)/i,
    /tool \w+ (?:denied|blocked|not allowed)/i,
    /insufficient permissions/i,
  ] as readonly RegExp[],

  // ── Layer 1: Tool result masking ───────────────────────────────────────
  /** Last N turns keep full tool result data; older turns get masked. */
  TOOL_RESULT_VERBATIM_TURNS: 5,

  // ── Layer 2: Background proactive summarization ────────────────────────
  /** Estimated unsummarized tokens to trigger background summarization. */
  SUMMARIZATION_SOFT_THRESHOLD: 90_000,
  /** Total context estimate to swap old messages for pre-built summary. */
  SUMMARIZATION_SWAP_THRESHOLD: 120_000,
  /** Minimum turns before summarization is considered. */
  MIN_TURNS_BEFORE_SUMMARIZATION: 12,
} as const;

export const isPoisonedAssistantTurn = (content: string): boolean =>
  HISTORY_POLICY.POISON_PATTERNS.some(p => p.test(content));
