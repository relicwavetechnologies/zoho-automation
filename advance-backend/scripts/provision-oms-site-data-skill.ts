import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionDivoOmsSiteDataForExistingCompanies } from '../src/application/skills/oms-site-data-system-skill';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionDivoOmsSiteDataForExistingCompanies(prisma);
    console.log(`OMS Site Data skill provisioned: ${result.created} created, ${result.updated} updated, ${result.existing} unchanged, ${result.skipped} skipped across ${result.companies} companies.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
