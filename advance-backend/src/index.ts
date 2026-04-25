import 'dotenv/config';
import { loadAndValidateEnv } from './config/env';
import { buildContainer } from './composition';
import { createServer } from './server';
import { disconnectPrisma } from './infrastructure/persistence/prisma.client';
import { disconnectRedis } from './infrastructure/cache/redis.client';

const main = async () => {
  const env = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const app = createServer(container);

  const server = app.listen(env.PORT, () => {
    container.logger.info('server.started', { port: env.PORT, env: env.NODE_ENV });
  });

  const shutdown = async (signal: string) => {
    container.logger.info('server.shutdown', { signal });
    server.close(async () => {
      await disconnectPrisma();
      await disconnectRedis();
      process.exit(0);
    });
    // Force shutdown after 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
};

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
