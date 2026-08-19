import type { Prisma } from '../../generated/prisma';
import { recordSkillRegistryMutation } from './skill-registry-versioning';
import {
  arraysEqual,
  deterministicSystemId,
  type SystemSkillDefinition,
} from './system-skill-definition';

export interface SystemSkillPlacement {
  readonly folderId: string | null;
  readonly departmentId: string | null;
  readonly scope: 'company' | 'department';
  readonly granteeType: 'company' | 'department';
  readonly granteeId: string;
}

export interface SystemSkillFolderSpec {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  readonly parentId?: string | null;
}

export type SystemSkillStore = Pick<
  Prisma.TransactionClient,
  'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'
>;

type ExistingSkill = {
  id: string;
  slug: string;
  companyId: string;
  departmentId: string | null;
  folderId: string | null;
  scope: string;
  name: string;
  summary: string;
  markdown: string;
  toolIds: string[];
  tags: string[];
  status: string;
  isSystem: boolean;
  sortOrder: number;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
  aliases?: { alias: string }[];
};

const EXISTING_SKILL_SELECT = {
  id: true,
  slug: true,
  companyId: true,
  departmentId: true,
  folderId: true,
  scope: true,
  name: true,
  summary: true,
  markdown: true,
  toolIds: true,
  tags: true,
  status: true,
  isSystem: true,
  sortOrder: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  aliases: { select: { alias: true }, orderBy: { alias: 'asc' as const } },
} as const;

export function buildSystemSkill(
  companyId: string,
  definition: SystemSkillDefinition,
  placement: SystemSkillPlacement,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return {
    id: deterministicSystemId(companyId, `skill:${definition.slug}`),
    companyId,
    ...definitionFields(definition, placement),
    toolIds: [...definition.toolIds],
    tags: [...definition.tags],
  };
}

export async function provisionSystemSkill(
  db: Pick<
    SystemSkillStore,
    'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'
  >,
  companyId: string,
  definition: SystemSkillDefinition,
  placement: SystemSkillPlacement,
): Promise<{ id: string; outcome: 'created' | 'updated' | 'existing' | 'skipped' }> {
  let current = await findCurrentSkill(db, companyId, definition);
  if (current && !current.isSystem) return { id: current.id, outcome: 'skipped' };

  let skill: ExistingSkill | undefined;
  let outcome: 'created' | 'updated' | 'existing' | undefined;
  if (!current) {
    try {
      skill = await db.skill.create({
        data: buildSystemSkill(companyId, definition, placement),
        select: EXISTING_SKILL_SELECT,
      }) as ExistingSkill;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      current = await findCurrentSkill(db, companyId, definition);
      if (!current) throw error;
      if (!current.isSystem) return { id: current.id, outcome: 'skipped' };
    }
    if (skill) {
      await recordSkillRegistryMutation(db, skill, 'system');
      outcome = 'created';
    }
  }
  if (current) {
    if (matchesDefinition(current, definition, placement)) {
      skill = current;
      outcome = 'existing';
    } else {
      skill = await db.skill.update({
        where: { id: current.id },
        data: {
          ...definitionFields(definition, placement),
          toolIds: [...definition.toolIds],
          tags: [...definition.tags],
          revision: { increment: 1 },
        },
        select: EXISTING_SKILL_SELECT,
      }) as ExistingSkill;
      await recordSkillRegistryMutation(db, skill, 'system');
      outcome = 'updated';
    }
  }
  if (!skill || !outcome) throw new Error(`Failed to reconcile system skill: ${definition.slug}`);

  await db.skillAccessGrant.upsert({
    where: {
      skillId_granteeType_granteeId: {
        skillId: skill.id,
        granteeType: placement.granteeType,
        granteeId: placement.granteeId,
      },
    },
    create: {
      companyId,
      skillId: skill.id,
      granteeType: placement.granteeType,
      granteeId: placement.granteeId,
    },
    update: {},
  });
  if (definition.aliases !== undefined) {
    await syncAliases(db, skill.id, definition.aliases);
  }

  return { id: skill.id, outcome };
}

export async function ensureSystemSkillFolder(
  db: Pick<SystemSkillStore, 'skillFolder'>,
  companyId: string,
  spec: SystemSkillFolderSpec,
): Promise<string> {
  const parentId = spec.parentId ?? null;
  const current = await db.skillFolder.findFirst({
    where: {
      companyId,
      departmentId: null,
      parentId,
      slug: spec.slug,
      status: 'active',
    },
    select: { id: true },
  });
  if (current) return current.id;

  const id = deterministicSystemId(companyId, spec.key);
  const folder = await db.skillFolder.upsert({
    where: { id },
    create: {
      id,
      companyId,
      departmentId: null,
      parentId,
      name: spec.name,
      slug: spec.slug,
      status: 'active',
      sortOrder: spec.sortOrder,
    },
    update: {
      departmentId: null,
      parentId,
      name: spec.name,
      slug: spec.slug,
      status: 'active',
      sortOrder: spec.sortOrder,
    },
    select: { id: true },
  });
  return folder.id;
}

async function findCurrentSkill(
  db: Pick<SystemSkillStore, 'skill'>,
  companyId: string,
  definition: SystemSkillDefinition,
): Promise<ExistingSkill | null> {
  const current = await db.skill.findFirst({
    where: { companyId, slug: definition.slug, status: { not: 'archived' } },
    select: EXISTING_SKILL_SELECT,
  }) as ExistingSkill | null;
  if (current || !definition.legacySlugs?.length) return current;
  return await db.skill.findFirst({
    where: {
      companyId,
      slug: { in: [...definition.legacySlugs] },
      status: { not: 'archived' },
      isSystem: true,
    },
    select: EXISTING_SKILL_SELECT,
  }) as ExistingSkill | null;
}

function definitionFields(definition: SystemSkillDefinition, placement: SystemSkillPlacement) {
  return {
    departmentId: placement.departmentId,
    folderId: placement.folderId,
    scope: placement.scope,
    name: definition.name,
    slug: definition.slug,
    summary: definition.summary,
    markdown: definition.markdown,
    status: 'active',
    isSystem: true,
    sortOrder: definition.sortOrder,
  } as const;
}

function matchesDefinition(
  current: ExistingSkill,
  definition: SystemSkillDefinition,
  placement: SystemSkillPlacement,
): boolean {
  return current.departmentId === placement.departmentId
    && current.folderId === placement.folderId
    && current.scope === placement.scope
    && current.name === definition.name
    && current.slug === definition.slug
    && current.summary === definition.summary
    && current.markdown === definition.markdown
    && current.status === 'active'
    && current.isSystem
    && current.sortOrder === definition.sortOrder
    && arraysEqual(current.toolIds, definition.toolIds)
    && arraysEqual(current.tags, definition.tags)
    && (definition.aliases === undefined
      || arraysEqual(
        (current.aliases ?? []).map((item) => item.alias),
        [...definition.aliases].sort(),
      ));
}

async function syncAliases(
  db: Pick<SystemSkillStore, 'skillAlias'>,
  skillId: string,
  aliases: readonly string[],
): Promise<void> {
  await db.skillAlias.deleteMany({ where: { skillId, alias: { notIn: [...aliases] } } });
  if (aliases.length === 0) return;
  await db.skillAlias.createMany({
    data: aliases.map((alias) => ({ skillId, alias })),
    skipDuplicates: true,
  });
}
