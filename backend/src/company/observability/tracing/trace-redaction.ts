const REDACT_KEY_PATTERNS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
];

const EXCLUDE_KEY_PATTERNS = [
  'text',
  'prompt',
  'content',
  'raw',
  'body',
  'payload',
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const shouldRedact = (key: string): boolean => {
  const lowered = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((pattern) => lowered.includes(pattern));
};

const shouldExclude = (key: string): boolean => {
  const lowered = key.toLowerCase();
  return EXCLUDE_KEY_PATTERNS.some((pattern) => lowered === pattern || lowered.endsWith(`_${pattern}`));
};

export const sanitizeTraceMeta = (value: unknown, depth = 0): unknown => {
  if (depth > 6) {
    return '[MaxDepthReached]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceMeta(item, depth + 1));
  }

  if (!isObject(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (shouldExclude(key)) {
      sanitized[key] = '[EXCLUDED]';
      continue;
    }
    if (shouldRedact(key)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    sanitized[key] = sanitizeTraceMeta(raw, depth + 1);
  }

  return sanitized;
};

