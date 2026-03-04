import express, { Application } from 'express';

import config from './config';
import expressLoader from './loaders/express';
import { logger } from './utils/logger';

export const createApp = async (): Promise<Application> => {
  const app = express();

  await expressLoader(app);

  logger.info(`Express initialized in ${config.NODE_ENV} mode`);

  return app;
};


