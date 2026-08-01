import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionKnowledgeForExistingCompanies } from '../src/application/skills/knowledge-provisioning';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionKnowledgeForExistingCompanies(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
