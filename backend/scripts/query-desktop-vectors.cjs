const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const docs = await prisma.vectorDocument.findMany({
    where: {
      payload: {
        path: ['channel'],
        equals: 'desktop'
      }
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, ownerUserId: true, createdAt: true, payload: true },
    take: 5
  });
  console.log("Latest Desktop Vectors in Postgres:");
  console.dir(docs, { depth: null });
  await prisma.$disconnect();
}
run();
