import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

export interface DivoProductivitySystemSkillDefinition {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly sortOrder: number;
}

const DIVO_PRODUCTIVITY_FOLDER = {
  name: 'Divo Productivity',
  slug: 'divo-productivity',
  departmentId: null,
  parentId: null,
  status: 'active',
  sortOrder: 10,
} as const;

type DivoProductivitySkillStore = Pick<
  Prisma.TransactionClient,
  'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'
>;

type ExistingSkill = {
  id: string;
  companyId: string;
  departmentId: string | null;
  folderId: string | null;
  scope: string;
  name: string;
  slug: string;
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
  aliases: { alias: string }[];
};

const EXISTING_SKILL_SELECT = {
  id: true,
  companyId: true,
  departmentId: true,
  folderId: true,
  scope: true,
  name: true,
  slug: true,
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

export async function provisionDivoProductivitySystemSkill(
  db: DivoProductivitySkillStore,
  companyId: string,
  definition: DivoProductivitySystemSkillDefinition,
): Promise<{ id: string; outcome: 'created' | 'updated' | 'existing' | 'skipped' }> {
  const folderId = await ensureFolder(db, companyId);
  const current = await db.skill.findFirst({
    where: { companyId, slug: definition.slug, status: { not: 'archived' } },
    select: EXISTING_SKILL_SELECT,
  }) as ExistingSkill | null;
  if (current && !current.isSystem) return { id: current.id, outcome: 'skipped' };

  let skill: ExistingSkill;
  let outcome: 'created' | 'updated' | 'existing';
  if (!current) {
    skill = await db.skill.create({
      data: buildDivoProductivitySystemSkill(companyId, folderId, definition),
      select: EXISTING_SKILL_SELECT,
    }) as ExistingSkill;
    await recordSkillRegistryMutation(db, skill, 'system');
    outcome = 'created';
  } else if (matchesDefinition(current, folderId, definition)) {
    skill = current;
    outcome = 'existing';
  } else {
    skill = await db.skill.update({
      where: { id: current.id },
      data: {
        ...definitionFields(folderId, definition),
        toolIds: [...definition.toolIds],
        tags: [...definition.tags],
        revision: { increment: 1 },
      },
      select: EXISTING_SKILL_SELECT,
    }) as ExistingSkill;
    await recordSkillRegistryMutation(db, skill, 'system');
    outcome = 'updated';
  }

  await db.skillAccessGrant.upsert({
    where: {
      skillId_granteeType_granteeId: {
        skillId: skill.id,
        granteeType: 'company',
        granteeId: companyId,
      },
    },
    create: {
      companyId,
      skillId: skill.id,
      granteeType: 'company',
      granteeId: companyId,
    },
    update: {},
  });
  await syncAliases(db, skill.id, definition.aliases);

  return { id: skill.id, outcome };
}

export async function provisionDivoProductivitySkillForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
  definition: DivoProductivitySystemSkillDefinition,
): Promise<{ companies: number; created: number; updated: number; existing: number; skipped: number }> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = { companies: companies.length, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const company of companies) {
    const result = await provisionDivoProductivitySystemSkill(db, company.id, definition);
    totals[result.outcome] += 1;
  }
  return totals;
}

export function buildDivoProductivitySystemSkill(
  companyId: string,
  folderId: string,
  definition: DivoProductivitySystemSkillDefinition,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return {
    id: deterministicId(companyId, `skill:${definition.slug}`),
    companyId,
    ...definitionFields(folderId, definition),
    toolIds: [...definition.toolIds],
    tags: [...definition.tags],
  };
}

async function ensureFolder(db: DivoProductivitySkillStore, companyId: string): Promise<string> {
  const current = await db.skillFolder.findFirst({
    where: {
      companyId,
      departmentId: null,
      parentId: null,
      slug: DIVO_PRODUCTIVITY_FOLDER.slug,
      status: 'active',
    },
    select: { id: true },
  });
  if (current) return current.id;

  const folder = await db.skillFolder.upsert({
    where: { id: deterministicId(companyId, 'folder:divo-productivity') },
    create: {
      id: deterministicId(companyId, 'folder:divo-productivity'),
      companyId,
      ...DIVO_PRODUCTIVITY_FOLDER,
    },
    update: { ...DIVO_PRODUCTIVITY_FOLDER },
    select: { id: true },
  });
  return folder.id;
}

function definitionFields(folderId: string, definition: DivoProductivitySystemSkillDefinition) {
  return {
    departmentId: null,
    folderId,
    scope: 'global',
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
  folderId: string,
  definition: DivoProductivitySystemSkillDefinition,
): boolean {
  return current.departmentId === null
    && current.folderId === folderId
    && current.scope === 'global'
    && current.name === definition.name
    && current.slug === definition.slug
    && current.summary === definition.summary
    && current.markdown === definition.markdown
    && current.status === 'active'
    && current.isSystem
    && current.sortOrder === definition.sortOrder
    && arraysEqual(current.toolIds, definition.toolIds)
    && arraysEqual(current.tags, definition.tags)
    && arraysEqual(current.aliases.map((item) => item.alias), [...definition.aliases].sort());
}

async function syncAliases(
  db: DivoProductivitySkillStore,
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

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicId(companyId: string, key: string): string {
  const hex = createHash('md5').update(`${companyId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
