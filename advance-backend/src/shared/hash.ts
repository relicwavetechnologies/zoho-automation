import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Hash JSON by value rather than JavaScript object insertion order. PostgreSQL
 * JSONB may reorder keys, so persisted approval fingerprints must use this
 * canonical representation on both write and read.
 */
export function sha256CanonicalJson(input: unknown): string {
  const serialized = JSON.stringify(canonicalizeJson(input));
  if (serialized === undefined) {
    throw new TypeError('Cannot hash a value that is not representable as JSON.');
  }
  return sha256(serialized);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value === null || typeof value !== 'object') return value;

  const jsonValue = typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (jsonValue !== value) return canonicalizeJson(jsonValue);

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
      return sorted;
    }, {});
}
