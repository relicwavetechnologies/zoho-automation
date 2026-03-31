import 'dotenv/config';

import { PrismaClient } from '../src/generated/prisma';
import { larkDirectorySyncService } from '../src/company/channels/lark/lark-directory-sync.service';

const prisma = new PrismaClient();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const countNullEmailByCompany = async (): Promise<Map<string, number>> => {
  const rows = await prisma.channelIdentity.groupBy({
    by: ['companyId'],
    where: {
      channel: 'lark',
      email: null,
    },
    _count: {
      _all: true,
    },
  });

  return new Map(rows.map((row) => [row.companyId, row._count._all]));
};

const main = async () => {
  const before = await countNullEmailByCompany();
  const companyIds = [...before.keys()];

  if (companyIds.length === 0) {
    console.log('No null-email Lark channel identities found.');
    return;
  }

  console.log('Null-email Lark channel identities before backfill:');
  for (const companyId of companyIds) {
    console.log(`${companyId}: ${before.get(companyId) ?? 0}`);
  }

  for (const companyId of companyIds) {
    console.log(`Triggering Lark directory sync for ${companyId}...`);
    await larkDirectorySyncService.trigger(companyId, 'nightly');
  }

  console.log('Waiting 30000ms for sync jobs to run...');
  await sleep(30_000);

  const after = await countNullEmailByCompany();

  console.log('Null-email Lark channel identities after backfill:');
  for (const companyId of companyIds) {
    const beforeCount = before.get(companyId) ?? 0;
    const afterCount = after.get(companyId) ?? 0;
    const delta = beforeCount - afterCount;
    console.log(`${companyId}: ${beforeCount} -> ${afterCount} (reduced ${delta})`);
  }
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
