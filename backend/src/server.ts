import config from './config';
import loaders from './loaders';
import { logger } from './utils/logger';

const startServer = async () => {
  try {
    const app = await loaders();

    app.listen(config.PORT, () => {
      logger.info(`🚀 Server running on port ${config.PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
};

void startServer();


