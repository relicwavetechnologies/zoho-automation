import { prisma } from '../src/utils/prisma';

async function run() {
  const links = await prisma.larkUserAuthLink.findMany();
  console.log("=== Active Lark User Auth Links ===");
  console.dir(links, { depth: null });
  await prisma.$disconnect();
}
run();
