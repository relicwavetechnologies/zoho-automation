import { Application } from 'express';

import { createApp } from '../app';
import { initDatabase } from './database';
import { initEmiacBoundaries } from './emiac-boundaries';

const loaders = async (): Promise<Application> => {
  await initDatabase();
  initEmiacBoundaries();
  const app = await createApp();
  return app;
};

export default loaders;

