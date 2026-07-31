import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionZohoFinanceSkillsForExistingCompanies } from '../src/application/skills/zoho-finance-system-skills';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionZohoFinanceSkillsForExistingCompanies(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
