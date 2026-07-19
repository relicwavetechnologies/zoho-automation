import type { Prisma } from '../../generated/prisma';

/**
 * Keeps mutable Skill rows, immutable snapshots, and the company registry
 * revision in sync. Call immediately after a successful registry mutation.
 */

export interface VersionedSkillRecord {
  readonly id: string;
  readonly companyId: string;
  readonly departmentId: string | null;
  readonly scope: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  readonly status: string;
  readonly revision: number;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
}

export type SkillRegistryVersioningStore = Pick<
  Prisma.TransactionClient,
  'skillVersion' | 'skillRegistryRevision'
>;

export async function recordSkillRegistryMutation(
  store: SkillRegistryVersioningStore,
  skill: VersionedSkillRecord,
  source: 'publish' | 'archive' | 'system' | 'teach' = 'publish',
): Promise<void> {
  await store.skillVersion.upsert({
    where: { skillId_revision: { skillId: skill.id, revision: skill.revision } },
    create: {
      skillId: skill.id,
      revision: skill.revision,
      name: skill.name,
      summary: skill.summary,
      markdown: skill.markdown,
      toolIds: [...skill.toolIds],
      tags: [...skill.tags],
      scope: skill.scope,
      departmentId: skill.departmentId,
      status: skill.status,
      createdBy: skill.updatedBy ?? skill.createdBy,
      source,
    },
    // The (skillId, revision) pair is immutable. Retrying a completed write
    // must not rewrite its historical snapshot.
    update: {},
  });

  await store.skillRegistryRevision.upsert({
    where: { companyId: skill.companyId },
    create: { companyId: skill.companyId, revision: 2 },
    update: { revision: { increment: 1 } },
  });
}
