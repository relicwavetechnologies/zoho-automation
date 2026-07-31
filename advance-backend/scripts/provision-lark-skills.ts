import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionLarkSkillsForExistingCompanies } from '../src/application/skills/lark-skill-provisioning';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionLarkSkillsForExistingCompanies(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
