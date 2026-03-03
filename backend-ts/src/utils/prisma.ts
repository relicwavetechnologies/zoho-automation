import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

const shutdown = async () => {
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


