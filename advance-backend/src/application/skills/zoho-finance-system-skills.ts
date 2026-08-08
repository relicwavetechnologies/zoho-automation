import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  financeZohoRouterSkill,
  zohoBillNotifyAccountsSkill,
  zohoBooksBillSkill,
  zohoBooksInvoiceSkill,
  zohoBooksReadAnalysisSkill,
  zohoCrmReadAnalysisSkill,
} from './zoho.skill';
import { recordSkillRegistryMutation } from './skill-registry-versioning';

export interface ZohoFinanceSystemSkillDefinition {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
  /**
   * Phrases a member actually types. Router search scores slug, name and tags at
   * 5, an alias term at 4, an exact alias phrase at 10, and the summary at 2 —
   * markdown is never scored. Without these, "create an invoice" matched nothing
   * in this family and the finance router lost to alphabetical order.
   */
  readonly aliases: readonly string[];
  readonly sortOrder: number;
}

export const ZOHO_FINANCE_SYSTEM_SKILLS: readonly ZohoFinanceSystemSkillDefinition[] = [
  {
    slug: financeZohoRouterSkill.id,
    name: financeZohoRouterSkill.name,
    summary: financeZohoRouterSkill.description,
    markdown: `# ${financeZohoRouterSkill.name}\n\n${financeZohoRouterSkill.instructions}`,
    toolIds: financeZohoRouterSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'crm', 'router'],
    aliases: [
      'create an invoice', 'raise an invoice', 'make an invoice', 'new invoice',
      'send an invoice', 'email an invoice', 'bill a customer', 'invoice a client',
      'record a bill', 'enter a vendor bill', 'vendor invoice', 'supplier invoice',
      'record a payment', 'mark as paid',
      'unpaid invoices', 'outstanding invoices', 'overdue invoices', 'receivables',
      'payables', 'aging report', 'accounts receivable', 'accounts payable',
      'zoho books', 'zoho crm', 'chart of accounts', 'tax summary', 'gst',
    ],
    sortOrder: 10,
  },
  {
    slug: zohoCrmReadAnalysisSkill.id,
    name: zohoCrmReadAnalysisSkill.name,
    summary: zohoCrmReadAnalysisSkill.description,
    markdown: `# ${zohoCrmReadAnalysisSkill.name}\n\n${zohoCrmReadAnalysisSkill.instructions}`,
    toolIds: zohoCrmReadAnalysisSkill.toolIds,
    tags: ['finance', 'zoho', 'crm', 'read', 'analysis'],
    aliases: ['crm customer', 'crm lead', 'crm deal', 'crm account', 'sales pipeline'],
    sortOrder: 12,
  },
  {
    slug: zohoBooksReadAnalysisSkill.id,
    name: zohoBooksReadAnalysisSkill.name,
    summary: zohoBooksReadAnalysisSkill.description,
    markdown: `# ${zohoBooksReadAnalysisSkill.name}\n\n${zohoBooksReadAnalysisSkill.instructions}`,
    toolIds: zohoBooksReadAnalysisSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'read', 'reporting', 'analysis'],
    aliases: [
      'unpaid invoices', 'outstanding invoices', 'overdue invoices', 'receivables',
      'payables', 'aging report', 'invoice list', 'recent payments', 'bank transactions',
      'chart of accounts', 'tax summary', 'item rate', 'product list', 'gst rate', 'tax rates',
      'vendor balance', 'customer balance',
    ],
    sortOrder: 15,
  },
  {
    slug: zohoBooksInvoiceSkill.id,
    name: zohoBooksInvoiceSkill.name,
    summary: zohoBooksInvoiceSkill.description,
    markdown: `# ${zohoBooksInvoiceSkill.name}\n\n${zohoBooksInvoiceSkill.instructions}`,
    toolIds: zohoBooksInvoiceSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'invoices', 'write'],
    aliases: [
      'create an invoice', 'raise an invoice', 'make an invoice', 'new invoice',
      'send an invoice', 'email an invoice', 'issue an invoice', 'bill a customer',
      'invoice a client', 'fix an invoice', 'correct an invoice', 'edit an invoice',
      'attach pdf to invoice', 'add a customer', 'new customer',
    ],
    sortOrder: 18,
  },
  {
    slug: zohoBooksBillSkill.id,
    name: zohoBooksBillSkill.name,
    summary: zohoBooksBillSkill.description,
    markdown: `# ${zohoBooksBillSkill.name}\n\n${zohoBooksBillSkill.instructions}`,
    toolIds: zohoBooksBillSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'bills', 'invoices'],
    aliases: [
      'record a bill', 'enter a vendor bill', 'create a bill', 'vendor invoice',
      'supplier invoice', 'book this invoice', 'process this invoice pdf',
    ],
    sortOrder: 20,
  },
  {
    slug: zohoBillNotifyAccountsSkill.id,
    name: zohoBillNotifyAccountsSkill.name,
    summary: zohoBillNotifyAccountsSkill.description,
    markdown: `# ${zohoBillNotifyAccountsSkill.name}\n\n${zohoBillNotifyAccountsSkill.instructions}`,
    toolIds: zohoBillNotifyAccountsSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'lark', 'notifications'],
    aliases: ['notify accounts', 'tell core accounts', 'inform the accounts group'],
    sortOrder: 30,
  },
] as const;

type ZohoFinanceSkillStore = Pick<
  Prisma.TransactionClient,
  'department' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'
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
  aliases: { alias: string }[];
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

export async function provisionZohoFinanceSystemSkills(
  db: ZohoFinanceSkillStore,
  companyId: string,
): Promise<{
  departmentId: string | null;
  created: number;
  updated: number;
  existing: number;
  skipped: number;
  /** Slugs left untouched because an admin edit cleared isSystem. A silent
   *  skip here means the company keeps the old instructions forever. */
  skippedSlugs: string[];
}> {
  const departments = await db.department.findMany({
    where: { companyId, status: 'active' },
    select: { id: true, name: true, slug: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const department = departments.find(candidate => candidate.slug.toLowerCase() === 'finance')
    ?? departments.find(candidate => isFinanceDepartment(candidate.name, candidate.slug));
  if (!department) {
    return {
      departmentId: null, created: 0, updated: 0, existing: 0,
      skipped: ZOHO_FINANCE_SYSTEM_SKILLS.length,
      skippedSlugs: ZOHO_FINANCE_SYSTEM_SKILLS.map(definition => definition.slug),
    };
  }

  let created = 0;
  let updated = 0;
  let existing = 0;
  let skipped = 0;
  const skippedSlugs: string[] = [];

  for (const definition of ZOHO_FINANCE_SYSTEM_SKILLS) {
    const current = await db.skill.findFirst({
      where: { companyId, slug: definition.slug, status: { not: 'archived' } },
      select: EXISTING_SKILL_SELECT,
    }) as ExistingSkill | null;

    if (current && !current.isSystem) {
      skipped += 1;
      skippedSlugs.push(definition.slug);
      continue;
    }

    let skill: ExistingSkill;
    if (!current) {
      skill = await db.skill.create({
        data: buildZohoFinanceSystemSkill(companyId, department.id, definition),
        select: EXISTING_SKILL_SELECT,
      }) as ExistingSkill;
      await syncAliases(db, skill.id, definition.aliases);
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
        select: EXISTING_SKILL_SELECT,
      }) as ExistingSkill;
      await syncAliases(db, skill.id, definition.aliases);
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

  return { departmentId: department.id, created, updated, existing, skipped, skippedSlugs };
}

export async function provisionZohoFinanceSkillsForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'department' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
): Promise<{
  companies: number;
  created: number;
  updated: number;
  existing: number;
  skipped: number;
  skippedByCompany: Array<{ companyId: string; slugs: string[] }>;
}> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = {
    companies: companies.length,
    created: 0, updated: 0, existing: 0, skipped: 0,
    skippedByCompany: [] as Array<{ companyId: string; slugs: string[] }>,
  };

  for (const company of companies) {
    const result = await provisionZohoFinanceSystemSkills(db, company.id);
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
    if (result.skippedSlugs.length > 0) {
      totals.skippedByCompany.push({ companyId: company.id, slugs: result.skippedSlugs });
    }
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
    && arraysEqual(current.tags, definition.tags)
    // Without this an alias-only change compares equal, takes the untouched
    // branch, and never writes the alias rows.
    && arraysEqual(current.aliases.map((item) => item.alias), [...definition.aliases].sort());
}

async function syncAliases(
  db: ZohoFinanceSkillStore,
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
