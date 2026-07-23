import { getPrismaClient } from '../src/infrastructure/persistence/prisma.client';
import { provisionDivoPythonAutomationForExistingCompanies } from '../src/application/skills/divo-python-automation-system-skill';

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  try {
    console.log(JSON.stringify(await provisionDivoPythonAutomationForExistingCompanies(prisma)));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
