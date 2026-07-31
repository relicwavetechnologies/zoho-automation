/**
 * Server-side guard for department roles that may only see their own Zoho data.
 *
 * Zoho's list endpoints do not consistently honour an `email` filter across
 * Books modules, so callers must always verify returned records locally too.
 * We deliberately fail closed: a record without an email-bearing field is not
 * considered personal data.
 */

export function normalizedEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function isPersonalizedZohoScope(scope: string | undefined): boolean {
  return scope === 'personalized';
}

export function recordMatchesZohoEmail(record: unknown, requesterEmail: string): boolean {
  const expected = normalizedEmail(requesterEmail);
  if (!expected || record === null || typeof record !== 'object') return false;

  const seen = new WeakSet<object>();
  const visit = (value: unknown, key = ''): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return /email/i.test(key) && normalizedEmail(value) === expected;
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => visit(item, key));
    return Object.entries(value as Record<string, unknown>).some(([nestedKey, nestedValue]) => visit(nestedValue, nestedKey));
  };

  return visit(record);
}

export function filterZohoRecordsByEmail<T extends Record<string, unknown>>(records: readonly T[], requesterEmail: string): T[] {
  return records.filter(record => recordMatchesZohoEmail(record, requesterEmail));
}
