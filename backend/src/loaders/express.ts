import express, { Application } from 'express';

import exampleRoutes from '../modules/example/example.routes';
import userRoutes from '../modules/user/user.routes';
import { errorMiddleware } from '../middlewares/error.middleware';

const expressLoader = async (app: Application): Promise<void> => {
  app.use(express.json());

  // Register module routers
  app.use('/api/example', exampleRoutes);
  app.use('/api/users', userRoutes);

  // Error middleware must be registered last
  app.use(errorMiddleware);
};

export default expressLoader;


