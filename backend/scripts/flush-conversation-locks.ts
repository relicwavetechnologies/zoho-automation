import { stateRedisConnection } from '../src/company/queue/redis/state-redis.connection';

const run = async () => {
  const client = stateRedisConnection.getClient();
  const keys = await client.keys('orchestration:conversation-lock:*');
  if (keys.length === 0) {
    console.log('No conversation locks found');
  } else {
    await client.del(...keys);
    console.log(`Deleted ${keys.length} lock(s):`, keys);
  }
  await client.quit();
};

run().catch(console.error);
