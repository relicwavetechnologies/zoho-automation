import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionDivoSemrushForExistingCompanies } from '../src/application/skills/semrush-system-skill';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionDivoSemrushForExistingCompanies(prisma);
    console.log(`Semrush skill provisioned: ${result.created} created, ${result.updated} updated, ${result.existing} unchanged, ${result.skipped} skipped across ${result.companies} companies.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
