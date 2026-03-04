import config from './config';
import { initializeOrchestrationRuntime, shutdownOrchestrationRuntime } from './company/queue/runtime';
import loaders from './loaders';
import { logger } from './utils/logger';

const startServer = async () => {
  try {
    await initializeOrchestrationRuntime();
    const app = await loaders();

    app.listen(config.PORT, () => {
      logger.info(`🚀 Server running on port ${config.PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
};

const gracefulShutdown = async () => {
  try {
    await shutdownOrchestrationRuntime();
  } catch (error) {
    logger.error('Failed to shutdown orchestration runtime cleanly', error);
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

void startServer();

