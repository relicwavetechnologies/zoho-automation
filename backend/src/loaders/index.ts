import { Application } from 'express';

import { createApp } from '../app';
import { initEmiacBoundaries } from './emiac-boundaries';

const loaders = async (): Promise<Application> => {
  initEmiacBoundaries();
  const app = await createApp();
  return app;
};

export default loaders;
