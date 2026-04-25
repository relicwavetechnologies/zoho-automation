import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from './composition';
import { createHealthRoutes } from './http/health.routes';
import { createErrorBoundary } from './http/error-boundary';
import { createLarkWebhookRoutes } from './infrastructure/channels/lark/lark.webhook.routes';
import { createAdminPermissionRoutes } from './http/admin/permission.routes';
import { createGoogleAuthRoutes } from './http/google/google-auth.routes';
import { createZohoAuthRoutes } from './http/zoho/zoho-auth.routes';
import { createExecutionRoutes } from './http/executions/execution.routes';
import { createAdminAuthMiddleware } from './http/middleware/admin-auth.middleware';
import { createMemberAuthMiddleware } from './http/middleware/member-auth.middleware';
import { createFilesRouter } from './http/files/files.routes';
import { IngestionWorker } from './application/ingestion/ingestion.worker';

export const createServer = (c: Container) => {
  const app = express();

  // Boot BullMQ ingestion worker (queue lives in container, shared with webhook routes)
  const ingestionWorker = new IngestionWorker({
    redisUrl:         c.env.REDIS_URL,
    ingestionService: c.ingestionService,
    larkAdapter:      c.larkAdapter,
    env:              c.env,
    logger:           c.logger,
    concurrency:      c.env.INGESTION_WORKER_CONCURRENCY,
  });
  ingestionWorker.start();

  // Capture the raw JSON body string on every request before parsing.
  // The webhook handler needs it to verify the HMAC-SHA256 signature.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        // Attach raw body for HMAC verification; use unknown-cast to avoid module augmentation.
        (req as unknown as Record<string, unknown>)['rawBody'] = buf.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  // ── Request correlation middleware ──────────────────────────────────────
  // Generates / propagates x-request-id on every request for log correlation.
  app.use((req, res, next) => {
    const requestId = (req.headers['x-request-id'] as string | undefined)
      ?? randomUUID();
    res.setHeader('x-request-id', requestId);
    (req as unknown as Record<string, unknown>)['requestId'] = requestId;
    next();
  });

  // ── Structured HTTP request logging ────────────────────────────────────
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    c.logger.debug('http.request', {
      method:    req.method,
      path:      req.path,
      requestId: (req as unknown as Record<string, unknown>)['requestId'],
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const level = res.statusCode >= 500 ? 'error'
        : res.statusCode >= 400 ? 'warn'
        : 'debug';
      c.logger[level]('http.response', {
        method:    req.method,
        path:      req.path,
        status:    res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        requestId: (req as unknown as Record<string, unknown>)['requestId'],
      });
    });
    next();
  });

  // Routes
  app.use('/health', createHealthRoutes(c.prisma));

  app.use(
    '/admin',
    createAdminPermissionRoutes({
      toolPermRepo:    c.toolPermRepo,
      toolActionRepo:  c.toolActionRepo,
      deptToolPermRepo: c.deptToolPermRepo,
      permissions:     c.permissions,
      logger:          c.logger,
      auditService:    c.auditService,
    }),
  );

  app.use(
    '/webhooks/lark',
    createLarkWebhookRoutes({
      adapter:               c.larkAdapter,
      engine:                c.engine,
      channelIdentityRepo:   c.channelIdentityRepo,
      conversationRepo:      c.conversationRepo,
      logger:                c.logger,
      env:                   c.env,
      approvalGate:          c.approvalGate,
      approvalCardHandler:   c.approvalCardHandler,
      ingestionQueue:        c.ingestionQueue,
      knowledgeShareService: c.knowledgeShareService,
      shareResolverService:  c.shareResolverService,
    }),
  );

  // Google OAuth connect + callback
  app.use(
    '/api/google/auth',
    createGoogleAuthRoutes({
      googleOAuthService:    c.googleOAuthService,
      googleUserLinkRepo:    c.googleUserLinkRepo,
      companyGoogleAuthRepo: c.companyGoogleLinkRepo,
      cache:                 c.cache,
      logger:                c.logger,
      frontendBaseUrl:       c.env.APP_BASE_URL,
    }),
  );

  // Zoho OAuth connect + callback
  app.use(
    '/api/zoho/auth',
    createZohoAuthRoutes({
      zohoTokenService:   c.zohoTokenService,
      zohoConnectionRepo: c.zohoConnectionRepo,
      cache:              c.cache,
      logger:             c.logger,
      env:                c.env,
      frontendBaseUrl:    c.env.APP_BASE_URL,
    }),
  );

  // Execution trace routes (read-only observability, admin-auth required)
  const adminAuth = createAdminAuthMiddleware({
    prisma:          c.prisma,
    jwtSecret:       c.env.ADMIN_JWT_SECRET,
    ...(c.env.INTERNAL_API_KEY !== undefined ? { internalApiKey: c.env.INTERNAL_API_KEY } : {}),
    logger:          c.logger,
  });
  app.use(
    '/api/executions',
    adminAuth,
    createExecutionRoutes({
      executionQueryService: c.executionQueryService,
      logger:                c.logger,
    }),
  );

  // ── File management routes (member auth) ─────────────────────────────────
  const memberAuth = createMemberAuthMiddleware({
    prisma:    c.prisma,
    jwtSecret: c.env.MEMBER_JWT_SECRET,
    logger:    c.logger,
  });
  app.use(
    '/api/files',
    memberAuth,
    createFilesRouter({
      ingestionService:      c.ingestionService,
      ingestionQueue:        c.ingestionQueue,
      fileAssetRepo:         c.fileAssetRepo,
      fileAccessPolicyRepo:  c.fileAccessPolicyRepo,
      knowledgeShareService: c.knowledgeShareService,
      logger:                c.logger,
      maxFileSizeMb:         c.env.DOC_UPLOAD_MAX_MB,
    }),
  );

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Error boundary
  app.use(createErrorBoundary(c.logger) as any);

  return app;
};
