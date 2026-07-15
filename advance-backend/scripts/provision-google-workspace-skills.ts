import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionGoogleWorkspaceSkillsForExistingCompanies } from '../src/application/skills/google-workspace-system-skills';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionGoogleWorkspaceSkillsForExistingCompanies(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
