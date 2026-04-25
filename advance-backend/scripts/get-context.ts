import 'dotenv/config';
import { getPrismaClient, disconnectPrisma } from '../src/infrastructure/persistence/prisma.client';

void (async () => {
  const prisma = getPrismaClient();

  const identities = await prisma.channelIdentity.findMany({
    select: { id: true, companyId: true, externalUserId: true, channel: true, aiRole: true, displayName: true, email: true, larkOpenId: true },
    where: { channel: 'lark' },
  });
  console.log('ChannelIdentities:', JSON.stringify(identities, null, 2));

  const links = await prisma.larkUserAuthLink.findMany({
    select: { userId: true, companyId: true, larkOpenId: true, scopes: true },
    take: 10,
  });
  console.log('LarkUserAuthLinks:', JSON.stringify(links, null, 2));

  await disconnectPrisma();
})();
