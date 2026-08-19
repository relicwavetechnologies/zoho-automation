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

  /*
   * Long enough for a recording to arrive.
   *
   * Node cuts a request body off after five minutes by default, which is fine
   * for every JSON call here and wrong for the two routes that stream video: a
   * large upload on an ordinary connection takes longer, and the member sees a
   * dropped connection rather than a limit. Matched to the 1800s the proxy
   * allows those routes, so whichever gives up first gives up for the reason.
   *
   * Global, because Node has no per-route body timeout. That widens the window
   * for a slow-body client on *every* route — acceptable here only because this
   * process binds loopback and nginx buffers request bodies everywhere except
   * the two streaming locations, so such a client is cut off at the proxy
   * before it reaches this. If the backend is ever exposed directly, this
   * becomes a real slowloris surface and wants a per-handler `setTimeout`
   * instead.
   */
  server.requestTimeout = 1_800_000;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info('server.shutdown', { signal });
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    try {
      // Web runs are held in memory and no longer end when their reader
      // disconnects, so without this an open SSE view keeps the socket — and
      // the shutdown — waiting on work that will not survive the restart.
      container.webRunRegistry.clear();
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
