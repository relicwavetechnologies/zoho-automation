import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { provisionShareMemoryForExistingCompanies } from '../src/application/skills/share-memory-provisioning';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await provisionShareMemoryForExistingCompanies(prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
