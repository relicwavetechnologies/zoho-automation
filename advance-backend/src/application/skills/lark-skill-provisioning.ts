import type { PrismaClient } from '../../generated/prisma';
import { provisionLarkSystemSkills } from './lark-system-skills';

type ProvisioningDatabase = Pick<
  PrismaClient,
  'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant'
>;

export async function provisionLarkSkillsForExistingCompanies(
  db: ProvisioningDatabase,
): Promise<{ companies: number; created: number; updated: number; existing: number; skipped: number }> {
  const companies = await db.company.findMany({ select: { id: true } });
  const totals = { companies: companies.length, created: 0, updated: 0, existing: 0, skipped: 0 };

  for (const company of companies) {
    const result = await provisionLarkSystemSkills(db, company.id);
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
  }

  return totals;
}
