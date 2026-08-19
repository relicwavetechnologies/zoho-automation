import { createHash } from 'node:crypto';

/**
 * One checked-in shape for every seeded system skill. Code owns the
 * definition; Postgres is a projection. Catalog discovers rows, it does not
 * invent routers or route edges.
 */
export interface SystemSkillDefinition {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  readonly aliases?: readonly string[];
  readonly sortOrder: number;
  readonly legacySlugs?: readonly string[];
  readonly targetSlugs?: readonly string[];
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function deterministicSystemId(companyId: string, key: string): string {
  const hex = createHash('md5').update(`${companyId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
