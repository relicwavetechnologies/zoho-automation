import express, { Application, NextFunction, Request, Response } from 'express';

import config from '../config';
import { larkWebhookRoutes } from '../company/channels';
import adminControlsRoutes from '../modules/admin-controls/admin-controls.routes';
import adminAiModelsRoutes from '../modules/admin-ai-models/admin-ai-models.routes';
import adminRuntimeRoutes from '../modules/admin-runtime/admin-runtime.routes';
import adminAuthRoutes from '../modules/admin-auth/admin-auth.routes';
import auditRoutes from '../modules/audit/audit.routes';
import companyAdminRoutes from '../modules/company-admin/company-admin.routes';
import companyOnboardingRoutes from '../modules/company-onboarding/company-onboarding.routes';
import exampleRoutes from '../modules/example/example.routes';
import mastraRuntimeRoutes from '../modules/mastra-runtime/mastra-runtime.routes';
import rbacRoutes from '../modules/rbac/rbac.routes';
import userRoutes from '../modules/user/user.routes';
import memberAuthRoutes from '../modules/member-auth/member-auth.routes';
import desktopAuthRoutes from '../modules/desktop-auth/desktop-auth.routes';
import desktopThreadsRoutes from '../modules/desktop-threads/desktop-threads.routes';
import desktopChatRoutes from '../modules/desktop-chat/desktop-chat.routes';
import { errorMiddleware } from '../middlewares/error.middleware';
import { requestContextMiddleware, requestLoggingMiddleware } from '../middlewares/request-logging.middleware';

const allowedOrigins = config.CORS_ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
};

const expressLoader = async (app: Application): Promise<void> => {
  app.use(requestContextMiddleware);
  app.use(requestLoggingMiddleware);
  app.use(corsMiddleware);
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  // Register module routers
  app.use('/api/example', exampleRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/admin/auth', adminAuthRoutes);
  app.use('/api/admin/rbac', rbacRoutes);
  app.use('/api/admin/audit', auditRoutes);
  app.use('/api/admin/controls', adminControlsRoutes);
  app.use('/api/admin/ai-models', adminAiModelsRoutes);
  app.use('/api/admin/runtime', adminRuntimeRoutes);
  app.use('/api/admin/company', companyAdminRoutes);
  app.use('/api/onboarding', companyOnboardingRoutes);
  app.use('/api/agents', mastraRuntimeRoutes);
  app.use('/api/member/auth', memberAuthRoutes);
  app.use('/api/desktop/auth', desktopAuthRoutes);
  app.use('/api/desktop/threads', desktopThreadsRoutes);
  app.use('/api/desktop/chat', desktopChatRoutes);
  app.use('/webhooks/lark', larkWebhookRoutes);

  // Error middleware must be registered last
  app.use(errorMiddleware);
};

export default expressLoader;
