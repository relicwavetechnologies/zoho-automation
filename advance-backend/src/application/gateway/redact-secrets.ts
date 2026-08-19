/**
 * Take the credentials out of text a machine read off a screen.
 *
 * Anything OCR'd is text somebody had open at the time, and people have API
 * keys, tokens and bearer headers open all day. Whatever comes back is about to
 * be sent to a model provider and written to disk, so the keys come out first.
 *
 * Shared because there are now two ways a screen becomes text — a pasted image
 * and a video's frames — and two copies of this rule would mean the newer path
 * quietly having weaker rules than the older one. It is deliberately crude:
 * false positives cost a `[REDACTED]` in a caption, and false negatives cost a
 * live credential in a prompt.
 */

const PATTERNS: readonly [RegExp, string][] = [
  [/\b(sk-(?:or-v1-)?[a-z0-9_-]{16,})\b/gi, '[REDACTED_API_KEY]'],
  [/\b(gsk_[a-z0-9]{20,})\b/gi, '[REDACTED_API_KEY]'],
  [/\b(AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_API_KEY]'],
  [/\b([A-Za-z0-9+/]{40,}={0,2})\b/g, '[REDACTED_SECRET]'],
];

export function redactLikelySecrets(value: string): string {
  return PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}
