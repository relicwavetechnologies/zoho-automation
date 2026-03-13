import { Application } from 'express';

import { createApp } from '../app';
import { initCompanyBoundaries } from './company-boundaries';

const loaders = async (): Promise<Application> => {
  initCompanyBoundaries();
  const app = await createApp();
  return app;
};

export default loaders;
