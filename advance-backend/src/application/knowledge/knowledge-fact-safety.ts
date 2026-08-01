const SECRET_MARKER = String.raw`(?:api[ _-]?key|token|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|password|passwd|client[ _-]?secret|secret[ _-]?access[ _-]?key|secret|private[ _-]?key)`;
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b${SECRET_MARKER}\b\s*(?::|=)\s*(?!redacted\b|masked\b|unset\b|none\b|\*{3,})\S{4,}`,
  'i',
);
const SECRET_STATEMENT = new RegExp(
  String.raw`\b${SECRET_MARKER}\b\s+is\s+["']?(?!redacted\b|masked\b|unset\b|none\b|\*{3,})\S{6,}`,
  'i',
);
const PEM_PRIVATE_KEY = /-----BEGIN (?:(?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i;
const KNOWN_TOKEN_PREFIX = /(?:^|[^A-Za-z0-9_-])(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[A-Za-z0-9_-]{20,}|SK[0-9a-fA-F]{32})(?=$|[^A-Za-z0-9_-])/;
const JWT = /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?=$|[^A-Za-z0-9_-])/;

/**
 * Last-line guard for obvious credential material in explicitly published memory.
 * This intentionally does not attempt semantic secret classification.
 */
export function isSafePublishedMemoryFact(fact: string): boolean {
  return !SECRET_ASSIGNMENT.test(fact)
    && !SECRET_STATEMENT.test(fact)
    && !PEM_PRIVATE_KEY.test(fact)
    && !KNOWN_TOKEN_PREFIX.test(fact)
    && !JWT.test(fact);
}
