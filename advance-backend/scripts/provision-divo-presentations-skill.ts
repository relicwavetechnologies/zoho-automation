import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionDivoPresentationsForExistingCompanies } from '../src/application/skills/divo-presentations-system-skill';

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log(JSON.stringify(await provisionDivoPresentationsForExistingCompanies(prisma)));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
