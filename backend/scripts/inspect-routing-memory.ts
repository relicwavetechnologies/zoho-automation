import 'dotenv/config';

import { cacheRedisConnection } from '../src/company/queue/runtime/redis.connection';
import { prisma } from '../src/utils/prisma';

type Args = {
  companyId?: string;
  userId?: string;
  threadId?: string;
  conversationKey?: string;
  invalidateCache: boolean;
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const output: Args = {
    invalidateCache: false,
  };
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
      case '--thread-id':
        output.threadId = next;
        index += 1;
        break;
      case '--conversation-key':
        output.conversationKey = next;
        index += 1;
        break;
      case '--invalidate-cache':
        output.invalidateCache = true;
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
  return keys.sort();
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  if (!args.companyId || !args.userId) {
    throw new Error('Usage: tsx scripts/inspect-routing-memory.ts --company-id <id> --user-id <id> [--thread-id <id>] [--conversation-key <key>] [--invalidate-cache]');
  }

  const dbRows = await prisma.userMemoryItem.findMany({
    where: {
      companyId: args.companyId,
      userId: args.userId,
      kind: 'tool_routing',
      ...(args.threadId || args.conversationKey
        ? {
          OR: [
            { scope: 'user_global' },
            { scope: 'thread_pinned', threadId: args.threadId ?? null },
            { scope: 'thread_pinned', conversationKey: args.conversationKey ?? null },
          ],
        }
        : {}),
    },
    orderBy: [
      { updatedAt: 'desc' },
      { confidence: 'desc' },
    ],
    take: 50,
  });

  const redisPattern = `company:${args.companyId}:memory:*:user:${args.userId}:*`;
  const redis = cacheRedisConnection.getClient();
  const redisKeys = await scanKeys(redisPattern);

  if (args.invalidateCache && redisKeys.length > 0) {
    await redis.del(...redisKeys);
  }

  const redisValues = await Promise.all(
    redisKeys.map(async (key) => ({
      key,
      value: await redis.get(key),
    })),
  );

  console.log(JSON.stringify({
    companyId: args.companyId,
    userId: args.userId,
    threadId: args.threadId ?? null,
    conversationKey: args.conversationKey ?? null,
    db: {
      toolRoutingCount: dbRows.length,
      rows: dbRows.map((row) => ({
        id: row.id,
        scope: row.scope,
        subjectKey: row.subjectKey,
        summary: row.summary,
        confidence: row.confidence,
        status: row.status,
        threadId: row.threadId,
        conversationKey: row.conversationKey,
        updatedAt: row.updatedAt,
        valueJson: row.valueJson,
      })),
    },
    redis: {
      invalidated: args.invalidateCache,
      keyCount: redisKeys.length,
      keys: redisValues,
    },
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
