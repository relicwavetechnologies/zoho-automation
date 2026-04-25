import 'dotenv/config';
import { prisma } from '../src/utils/prisma';

const COMPANY_ID = '9f9360aa-28d1-49df-919f-3b121b7403df';
const LARK_OPEN_ID = 'ou_48b958c283635491b756c0ef23f47159';

async function main() {
  const ci = await prisma.channelIdentity.findFirst({
    where: { companyId: COMPANY_ID, channel: 'lark', larkOpenId: LARK_OPEN_ID },
    select: {
      id: true, displayName: true, email: true,
      aiRole: true, aiRoleSource: true, syncedAiRole: true, syncedFromLarkRole: true,
      sourceRoles: true,
    },
  });
  console.log('Channel identity for this Lark openId:');
  console.log(JSON.stringify(ci, null, 2));

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
