const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

const normalizeCandidate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || !EMAIL_REGEX.test(normalized)) {
    return undefined;
  }
  return normalized;
};

const collectFromString = (value: string, out: Set<string>): void => {
  const direct = normalizeCandidate(value);
  if (direct) {
    out.add(direct);
    return;
  }

  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (!matches) {
    return;
  }
  for (const match of matches) {
    const normalized = normalizeCandidate(match);
    if (normalized) {
      out.add(normalized);
    }
  }
};

const collectEmails = (value: unknown, out: Set<string>, seen: Set<object>): void => {
  if (typeof value === 'string') {
    collectFromString(value, out);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectEmails(item, out, seen);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value as object)) {
    return;
  }
  seen.add(value as object);

  for (const next of Object.values(value as Record<string, unknown>)) {
    collectEmails(next, out, seen);
  }
};

export const normalizeEmail = (value: unknown): string | undefined => normalizeCandidate(value);

export const extractNormalizedEmails = (value: unknown): string[] => {
  const out = new Set<string>();
  collectEmails(value, out, new Set<object>());
  return [...out];
};

export const payloadReferencesEmail = (payload: Record<string, unknown>, requesterEmail: string): boolean => {
  const normalizedRequesterEmail = normalizeEmail(requesterEmail);
  if (!normalizedRequesterEmail) {
    return false;
  }
  const emails = extractNormalizedEmails(payload);
  return emails.includes(normalizedRequesterEmail);
};
