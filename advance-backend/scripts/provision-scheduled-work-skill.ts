import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionScheduleDivoWorkForExistingCompanies } from '../src/application/skills/scheduled-work-system-skill';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionScheduleDivoWorkForExistingCompanies(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
