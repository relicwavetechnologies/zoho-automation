/** Rules for conversation history windowing and poison filtering. */
export const HISTORY_POLICY = {
  /** Max turns to include (user + assistant pairs) */
  MAX_TURNS: 20,
  /** Approximate max token budget for history */
  MAX_TOKEN_BUDGET: 8_000,
  /** Regex patterns that indicate a poisoned turn (agent confused by past failures) */
  POISON_PATTERNS: [
    /permission denied for tool/i,
    /i (?:cannot|can't|am unable to) (?:create|access|use|invoke)/i,
    /tool \w+ (?:denied|blocked|not allowed)/i,
    /insufficient permissions/i,
  ] as readonly RegExp[],
} as const;

export const isPoisonedAssistantTurn = (content: string): boolean =>
  HISTORY_POLICY.POISON_PATTERNS.some(p => p.test(content));
