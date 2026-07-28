import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { CONNECTED_PROVIDER_SYSTEM_SKILLS } from '../src/application/skills/connected-provider-system-skills';
import { provisionDivoProductivitySkillForExistingCompanies } from '../src/application/skills/divo-productivity-system-skills';
import { provisionGoogleWorkspaceSkillsForExistingCompanies } from '../src/application/skills/google-workspace-system-skills';
import { provisionLarkSkillsForExistingCompanies } from '../src/application/skills/lark-skill-provisioning';
import { provisionDivoOmsSiteDataForExistingCompanies } from '../src/application/skills/oms-site-data-system-skill';
import { provisionDivoSemrushForExistingCompanies } from '../src/application/skills/semrush-system-skill';
import { provisionZohoFinanceSkillsForExistingCompanies } from '../src/application/skills/zoho-finance-system-skills';
import { provisionDataExportSystemSkillForExistingCompanies } from '../src/application/skills/data-export-system-skill';
import { seedRegisteredTools } from './seed-registered-tools';

export async function provisionConnectedProviderSkillsForExistingCompanies(prisma: PrismaClient) {
  const totals = { companies: 0, created: 0, updated: 0, existing: 0, skipped: 0 };
  for (const definition of CONNECTED_PROVIDER_SYSTEM_SKILLS) {
    const result = await provisionDivoProductivitySkillForExistingCompanies(prisma, definition);
    totals.companies = result.companies;
    totals.created += result.created;
    totals.updated += result.updated;
    totals.existing += result.existing;
    totals.skipped += result.skipped;
  }
  return totals;
}

export async function reconcileCapabilities(prisma: PrismaClient) {
  const registeredTools = await seedRegisteredTools(prisma);
  const skills = {
    lark: await provisionLarkSkillsForExistingCompanies(prisma),
    google: await provisionGoogleWorkspaceSkillsForExistingCompanies(prisma),
    airtableAndAitable: await provisionConnectedProviderSkillsForExistingCompanies(prisma),
    zoho: await provisionZohoFinanceSkillsForExistingCompanies(prisma),
    dataExport: await provisionDataExportSystemSkillForExistingCompanies(prisma),
    semrush: await provisionDivoSemrushForExistingCompanies(prisma),
    oms: await provisionDivoOmsSiteDataForExistingCompanies(prisma),
  };
  return { registeredTools, skills };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(JSON.stringify(await reconcileCapabilities(prisma), null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
