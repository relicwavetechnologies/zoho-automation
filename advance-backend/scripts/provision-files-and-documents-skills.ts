import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionFilesAndDocumentsForExistingCompanies } from '../src/application/skills/files-and-documents-system-skills';

async function main() {
  const prisma = new PrismaClient();
  try {
    await provisionFilesAndDocumentsForExistingCompanies(prisma);
    console.log('provisioned files-and-documents system skills');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
