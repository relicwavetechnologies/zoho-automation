import express, { Application } from 'express';

import { larkWebhookRoutes } from '../emiac/channels';
import adminControlsRoutes from '../modules/admin-controls/admin-controls.routes';
import adminAuthRoutes from '../modules/admin-auth/admin-auth.routes';
import auditRoutes from '../modules/audit/audit.routes';
import companyAdminRoutes from '../modules/company-admin/company-admin.routes';
import companyOnboardingRoutes from '../modules/company-onboarding/company-onboarding.routes';
import exampleRoutes from '../modules/example/example.routes';
import rbacRoutes from '../modules/rbac/rbac.routes';
import userRoutes from '../modules/user/user.routes';
import { errorMiddleware } from '../middlewares/error.middleware';

const expressLoader = async (app: Application): Promise<void> => {
  app.use(express.json());

  // Register module routers
  app.use('/api/example', exampleRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/admin/auth', adminAuthRoutes);
  app.use('/api/admin/rbac', rbacRoutes);
  app.use('/api/admin/audit', auditRoutes);
  app.use('/api/admin/controls', adminControlsRoutes);
  app.use('/api/admin/company', companyAdminRoutes);
  app.use('/api/onboarding', companyOnboardingRoutes);
  app.use('/webhooks/lark', larkWebhookRoutes);

  // Error middleware must be registered last
  app.use(errorMiddleware);
};

export default expressLoader;
