import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { SystemSkillDefinition } from './system-skill-definition';
import {
  buildSystemSkill,
  ensureSystemSkillFolder,
  provisionSystemSkill,
  type SystemSkillStore,
} from './system-skill-provisioner';

export type DivoProductivitySystemSkillDefinition = SystemSkillDefinition & {
  readonly aliases: readonly string[];
};

const DIVO_PRODUCTIVITY_FOLDER = {
  key: 'folder:divo-productivity',
  name: 'Divo Productivity',
  slug: 'divo-productivity',
  sortOrder: 10,
} as const;

const COMPANY_PLACEMENT = (companyId: string, folderId: string) => ({
  folderId,
  departmentId: null,
  scope: 'company' as const,
  granteeType: 'company' as const,
  granteeId: companyId,
});

export async function provisionDivoProductivitySystemSkill(
  db: SystemSkillStore,
  companyId: string,
  definition: DivoProductivitySystemSkillDefinition,
): Promise<{ id: string; outcome: 'created' | 'updated' | 'existing' | 'skipped' }> {
  const folderId = await ensureSystemSkillFolder(db, companyId, DIVO_PRODUCTIVITY_FOLDER);
  return provisionSystemSkill(db, companyId, definition, COMPANY_PLACEMENT(companyId, folderId));
}

export async function provisionDivoProductivitySkillForExistingCompanies(
  db: Pick<PrismaClient, 'company'> & SystemSkillStore,
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
  return buildSystemSkill(companyId, definition, COMPANY_PLACEMENT(companyId, folderId));
}
