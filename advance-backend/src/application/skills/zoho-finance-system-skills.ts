import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import { financeOpsCoreSkill, zohoBillNotifyAccountsSkill, zohoBooksBillSkill } from './zoho.skill';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

export interface ZohoFinanceSystemSkillDefinition {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  readonly sortOrder: number;
}

export const ZOHO_FINANCE_SYSTEM_SKILLS: readonly ZohoFinanceSystemSkillDefinition[] = [
  {
    slug: financeOpsCoreSkill.id,
    name: financeOpsCoreSkill.name,
    summary: financeOpsCoreSkill.description,
    markdown: `# ${financeOpsCoreSkill.name}\n\n${financeOpsCoreSkill.instructions}`,
    toolIds: financeOpsCoreSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'crm', 'reporting'],
    sortOrder: 10,
  },
  {
    slug: zohoBooksBillSkill.id,
    name: zohoBooksBillSkill.name,
    summary: zohoBooksBillSkill.description,
    markdown: `# ${zohoBooksBillSkill.name}\n\n${zohoBooksBillSkill.instructions}`,
    toolIds: zohoBooksBillSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'bills', 'invoices'],
    sortOrder: 20,
  },
  {
    slug: zohoBillNotifyAccountsSkill.id,
    name: zohoBillNotifyAccountsSkill.name,
    summary: zohoBillNotifyAccountsSkill.description,
    markdown: `# ${zohoBillNotifyAccountsSkill.name}\n\n${zohoBillNotifyAccountsSkill.instructions}`,
    toolIds: zohoBillNotifyAccountsSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'lark', 'notifications'],
    sortOrder: 30,
  },
] as const;

type ZohoFinanceSkillStore = Pick<
  Prisma.TransactionClient,
  'department' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant'
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
} as const;

export async function provisionZohoFinanceSystemSkills(
  db: ZohoFinanceSkillStore,
  companyId: string,
): Promise<{
  departmentId: string | null;
  created: number;
  updated: number;
  existing: number;
  skipped: number;
}> {
  const departments = await db.department.findMany({
    where: { companyId, status: 'active' },
    select: { id: true, name: true, slug: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const department = departments.find(candidate => candidate.slug.toLowerCase() === 'finance')
    ?? departments.find(candidate => isFinanceDepartment(candidate.name, candidate.slug));
  if (!department) {
    return { departmentId: null, created: 0, updated: 0, existing: 0, skipped: ZOHO_FINANCE_SYSTEM_SKILLS.length };
  }

  let created = 0;
  let updated = 0;
  let existing = 0;
  let skipped = 0;

  for (const definition of ZOHO_FINANCE_SYSTEM_SKILLS) {
    const current = await db.skill.findFirst({
      where: { companyId, slug: definition.slug, status: { not: 'archived' } },
      select: EXISTING_SKILL_SELECT,
    }) as ExistingSkill | null;

    if (current && !current.isSystem) {
      skipped += 1;
      continue;
    }

    let skill: ExistingSkill;
    if (!current) {
      skill = await db.skill.create({
        data: buildZohoFinanceSystemSkill(companyId, department.id, definition),
      }) as ExistingSkill;
      await recordSkillRegistryMutation(db, skill, 'system');
      created += 1;
    } else if (matchesDefinition(current, department.id, definition)) {
      skill = current;
      existing += 1;
    } else {
      skill = await db.skill.update({
        where: { id: current.id },
        data: {
          ...definitionFields(department.id, definition),
          toolIds: [...definition.toolIds],
          tags: [...definition.tags],
          revision: { increment: 1 },
        },
      }) as ExistingSkill;
      await recordSkillRegistryMutation(db, skill, 'system');
      updated += 1;
    }

    await db.skillAccessGrant.upsert({
      where: {
        skillId_granteeType_granteeId: {
          skillId: skill.id,
          granteeType: 'department',
          granteeId: department.id,
        },
      },
      create: {
        companyId,
        skillId: skill.id,
        granteeType: 'department',
        granteeId: department.id,
      },
      update: {},
    });
  }

  return { departmentId: department.id, created, updated, existing, skipped };
}

export async function provisionZohoFinanceSkillsForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'department' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant'>,
): Promise<{ companies: number; created: number; updated: number; existing: number; skipped: number }> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = { companies: companies.length, created: 0, updated: 0, existing: 0, skipped: 0 };

  for (const company of companies) {
    const result = await provisionZohoFinanceSystemSkills(db, company.id);
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
  }
  return totals;
}

export function buildZohoFinanceSystemSkill(
  companyId: string,
  departmentId: string,
  definition: ZohoFinanceSystemSkillDefinition,
): Prisma.SkillUncheckedCreateInput & { id: string } {
  return {
    id: deterministicId(companyId, `skill:${definition.slug}`),
    companyId,
    ...definitionFields(departmentId, definition),
    toolIds: [...definition.toolIds],
    tags: [...definition.tags],
  };
}

function definitionFields(departmentId: string, definition: ZohoFinanceSystemSkillDefinition) {
  return {
    departmentId,
    folderId: null,
    scope: 'department',
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
  departmentId: string,
  definition: ZohoFinanceSystemSkillDefinition,
): boolean {
  return current.departmentId === departmentId
    && current.folderId === null
    && current.scope === 'department'
    && current.slug === definition.slug
    && current.name === definition.name
    && current.summary === definition.summary
    && current.markdown === definition.markdown
    && current.status === 'active'
    && current.isSystem
    && current.sortOrder === definition.sortOrder
    && arraysEqual(current.toolIds, definition.toolIds)
    && arraysEqual(current.tags, definition.tags);
}

function isFinanceDepartment(name: string, slug: string): boolean {
  return /\b(finance|financial|accounting|accounts|treasury)\b/i.test(`${name} ${slug}`);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicId(companyId: string, key: string): string {
  const hex = createHash('md5').update(`${companyId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
