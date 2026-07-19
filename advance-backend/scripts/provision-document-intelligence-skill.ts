import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionDivoDocumentIntelligenceForExistingCompanies } from '../src/application/skills/document-intelligence-system-skill';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionDivoDocumentIntelligenceForExistingCompanies(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
