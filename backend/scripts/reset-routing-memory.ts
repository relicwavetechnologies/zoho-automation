import 'dotenv/config';

import { cacheRedisConnection } from '../src/company/queue/runtime/redis.connection';
import { prisma } from '../src/utils/prisma';

type Args = {
  companyId?: string;
  userId?: string;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const output: Args = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    switch (value) {
      case '--company-id':
        output.companyId = next;
        index += 1;
        break;
      case '--user-id':
        output.userId = next;
        index += 1;
        break;
      default:
        break;
    }
  }
  return output;
};

const scanKeys = async (pattern: string): Promise<string[]> => {
  const redis = cacheRedisConnection.getClient();
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  if (!args.companyId || !args.userId) {
    throw new Error('Usage: tsx scripts/reset-routing-memory.ts --company-id <id> --user-id <id>');
  }

  const dbResult = await prisma.userMemoryItem.deleteMany({
    where: {
      companyId: args.companyId,
      userId: args.userId,
      kind: 'tool_routing',
    },
  });

  const redis = cacheRedisConnection.getClient();
  const cacheKeys = await scanKeys(`company:${args.companyId}:memory:*:user:${args.userId}:*`);
  const deletedRedis = cacheKeys.length > 0 ? await redis.del(...cacheKeys) : 0;

  console.log(JSON.stringify({
    companyId: args.companyId,
    userId: args.userId,
    deletedToolRoutingRows: dbResult.count,
    deletedRedisKeys: deletedRedis,
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await cacheRedisConnection.disconnect();
  });
