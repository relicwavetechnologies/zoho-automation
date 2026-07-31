import { getPrismaClient } from '../src/infrastructure/persistence/prisma.client';
import { provisionDivoLocalPythonForExistingCompanies } from '../src/application/skills/divo-local-python-system-skill';

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  try {
    console.log(JSON.stringify(await provisionDivoLocalPythonForExistingCompanies(prisma)));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
