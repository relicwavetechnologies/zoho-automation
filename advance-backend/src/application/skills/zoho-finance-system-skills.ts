import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  financeZohoRouterSkill,
  zohoBooksMoneySkill,
  zohoBillNotifyAccountsSkill,
  zohoBooksBillSkill,
  zohoBooksInvoiceSkill,
  zohoBooksPurchaseOrderSkill,
  zohoBooksReadAnalysisSkill,
  zohoCrmReadAnalysisSkill,
} from './zoho.skill';
import type { DivoProductivitySystemSkillDefinition } from './divo-productivity-system-skills';
import {
  buildSystemSkill,
  provisionSystemSkill,
  type SystemSkillStore,
} from './system-skill-provisioner';

export type ZohoFinanceSystemSkillDefinition = DivoProductivitySystemSkillDefinition;

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
      'create a purchase order', 'raise a purchase order', 'vendor purchase order',
      'create po', 'raise po', 'new po',
      // Search scores routers, not the specialists under them, so the phrases a
      // member uses for money movement have to be reachable here or the request
      // lands on whichever router happens to score highest — Airtable, in the
      // case of "log an expense".
      'record a payment', 'mark as paid', 'payment received', 'customer paid',
      'settle an invoice', 'apply a payment', 'money received',
      'log an expense', 'record an expense', 'add an expense', 'expense claim',
      'reimbursement', 'petty cash',
      'unpaid invoices', 'outstanding invoices', 'overdue invoices', 'receivables',
      'payables', 'aging report', 'accounts receivable', 'accounts payable',
      'gstr 2b', 'gstr-2b', '2b reconciliation', 'reconcile purchase bills',
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
      'gstr 2b', 'gstr-2b', '2b reconciliation', 'reconcile purchase bills',
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
    slug: zohoBooksPurchaseOrderSkill.id,
    name: zohoBooksPurchaseOrderSkill.name,
    summary: zohoBooksPurchaseOrderSkill.description,
    markdown: `# ${zohoBooksPurchaseOrderSkill.name}\n\n${zohoBooksPurchaseOrderSkill.instructions}`,
    toolIds: zohoBooksPurchaseOrderSkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'purchase-orders', 'procurement', 'write'],
    aliases: [
      'create a purchase order', 'raise a purchase order', 'new purchase order',
      'create po', 'raise po', 'new po',
      'vendor purchase order', 'supplier purchase order', 'procurement order',
      'order goods from vendor', 'order services from vendor', 'purchase order pdf',
    ],
    sortOrder: 19,
  },
  {
    slug: zohoBooksMoneySkill.id,
    name: zohoBooksMoneySkill.name,
    summary: zohoBooksMoneySkill.description,
    markdown: `# ${zohoBooksMoneySkill.name}\n\n${zohoBooksMoneySkill.instructions}`,
    toolIds: zohoBooksMoneySkill.toolIds,
    tags: ['finance', 'zoho', 'books', 'payments', 'expenses', 'write'],
    aliases: [
      'record a payment', 'received a payment', 'payment received', 'mark invoice paid',
      'settle an invoice', 'apply a payment', 'customer paid', 'money received',
      'log an expense', 'record an expense', 'add an expense', 'reimburse',
    ],
    sortOrder: 20,
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
      'reverse charge bill', 'rcm bill', 'unregistered vendor bill',
    ],
    sortOrder: 21,
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

/**
 * Phrases a member actually types. Router search scores slug, name and tags at
 * 5, an alias term at 4, an exact alias phrase at 10, and the summary at 2 —
 * markdown is never scored. Without these, "create an invoice" matched nothing
 * in this family and the finance router lost to alphabetical order.
 */

type ZohoFinanceSkillStore = Pick<Prisma.TransactionClient, 'department'> & SystemSkillStore;

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

  const placement = {
    folderId: null,
    departmentId: department.id,
    scope: 'department' as const,
    granteeType: 'department' as const,
    granteeId: department.id,
  };
  const totals = { created: 0, updated: 0, existing: 0, skipped: 0 };
  const skippedSlugs: string[] = [];
  for (const definition of ZOHO_FINANCE_SYSTEM_SKILLS) {
    const result = await provisionSystemSkill(db, companyId, definition, placement);
    totals[result.outcome] += 1;
    if (result.outcome === 'skipped') skippedSlugs.push(definition.slug);
  }

  return { departmentId: department.id, ...totals, skippedSlugs };
}

export async function provisionZohoFinanceSkillsForExistingCompanies(
  db: Pick<PrismaClient, 'company'> & ZohoFinanceSkillStore,
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
  return buildSystemSkill(companyId, definition, {
    folderId: null,
    departmentId,
    scope: 'department',
    granteeType: 'department',
    granteeId: departmentId,
  });
}

function isFinanceDepartment(name: string, slug: string): boolean {
  return /\b(finance|financial|accounting|accounts|treasury)\b/i.test(`${name} ${slug}`);
}
