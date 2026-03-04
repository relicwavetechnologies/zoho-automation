import config from './config';
import { initializeOrchestrationRuntime, shutdownOrchestrationRuntime } from './company/queue/runtime';
import loaders from './loaders';
import { logger } from './utils/logger';

let isShuttingDown = false;

const startServer = async () => {
  try {
    await initializeOrchestrationRuntime();
    const app = await loaders();

    app.listen(config.PORT, () => {
      logger.info('server.started', { port: config.PORT, nodeEnv: config.NODE_ENV }, { always: true });
    });
  } catch (error) {
    logger.fatal('server.start.failed', { error }, { always: true });
    process.exit(1);
  }
};

const gracefulShutdown = async () => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  try {
    logger.info('server.shutdown.start', undefined, { always: true });
    await shutdownOrchestrationRuntime();
    logger.info('server.shutdown.complete', undefined, { always: true });
  } catch (error) {
    logger.error('server.shutdown.failed', { error }, { always: true });
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => {
  void gracefulShutdown();
});

process.on('SIGTERM', () => {
  void gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', { reason }, { always: true });
});

process.on('uncaughtException', (error) => {
  logger.fatal('process.uncaught_exception', { error }, { always: true });
});

void startServer();
