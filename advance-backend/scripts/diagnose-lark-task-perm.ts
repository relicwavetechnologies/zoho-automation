import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();
const managerUserId = 'f6312e2b-d0d3-49fa-acba-786be69949e4';
const companyId     = '9f9360aa-28d1-49df-919f-3b121b7403df';

async function main() {
  // Where is larkOpenId stored for this user?
  const authLink = await prisma.larkUserAuthLink.findFirst({
    where: { userId: managerUserId },
    select: { larkOpenId: true, larkUserId: true },
  });
  console.log('\n=== LarkUserAuthLink ===', JSON.stringify(authLink, null, 2));

  const ci = await prisma.channelIdentity.findFirst({
    where: { channel: 'lark', companyId },
    select: { larkOpenId: true, displayName: true, aiRole: true },
    take: 3,
  } as any);
  console.log('\n=== ChannelIdentity (sample) ===', JSON.stringify(ci, null, 2));

  // All ChannelIdentity rows for users in Finance dept
  const deptUserIds = [
    'f6312e2b-d0d3-49fa-acba-786be69949e4', // MANAGER (you)
    '030b1cf5-97b9-4c7e-98ee-d9faf0cd3b46',
  ];
  const links = await prisma.larkUserAuthLink.findMany({
    where: { userId: { in: deptUserIds } },
    select: { userId: true, larkOpenId: true },
  });
  console.log('\n=== LarkUserAuthLink for dept users ===', JSON.stringify(links, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
