import 'dotenv/config';
import { loadAndValidateEnv } from './config/env';
import { buildContainer } from './composition';
import { createServer } from './server';
import { disconnectPrisma } from './infrastructure/persistence/prisma.client';
import { disconnectAllRedis } from './infrastructure/cache/redis.client';

const main = async () => {
  const env = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const app = createServer(container);

  const server = app.listen(env.PORT, () => {
    container.logger.info('server.started', { port: env.PORT, env: env.NODE_ENV });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info('server.shutdown', { signal });
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    try {
      const httpClosed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      await app.shutdown();
      await httpClosed;
      await disconnectPrisma();
      await disconnectAllRedis();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      container.logger.error('server.shutdown_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
};

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
