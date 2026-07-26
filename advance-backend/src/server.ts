import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from './composition';
import { createHealthRoutes } from './http/health.routes';
import { createErrorBoundary } from './http/error-boundary';
import {
  createLarkWebhookRoutes,
  processAcceptedLarkReceipt,
  replayLarkMessageAfterLogin,
  type LarkWebhookDeps,
} from './infrastructure/channels/lark/lark.webhook.routes';
import { createAdminAuthRoutes } from './http/admin/admin-auth.routes';
import { createAdminPermissionRoutes } from './http/admin/permission.routes';
import { createGoogleAuthRoutes } from './http/google/google-auth.routes';
import { createZohoAuthRoutes } from './http/zoho/zoho-auth.routes';
import { createLarkAuthRoutes } from './http/lark/lark-auth.routes';
import { createExecutionRoutes } from './http/executions/execution.routes';
import { createAdminAuthMiddleware } from './http/middleware/admin-auth.middleware';
import { createMemberAuthMiddleware } from './http/middleware/member-auth.middleware';
import { createDesktopToolsRoutes } from './http/desktop/desktop-tools.routes';
import { createDesktopDepartmentRoutes } from './http/desktop/desktop-departments.routes';
import { PermissionWriteService } from './application/permissions/permission-write.service';
import { createFilesRouter } from './http/files/files.routes';
import { createAgentsRoutes } from './http/agents/agents.routes';
import { createDepartmentRoutes } from './http/admin/departments.routes';
import { createSkillRegistryRoutes } from './http/admin/skill-registry.routes';
import { createMemoryRoutes } from './http/admin/memory.routes';
import { createCompanyRoutes } from './http/admin/company.routes';
import { createAuditRoutes } from './http/admin/audit.routes';
import { createControlsRoutes } from './http/admin/controls.routes';
import { createRbacRoutes } from './http/admin/rbac.routes';
import { createAiModelsRoutes } from './http/admin/ai-models.routes';
import { createAiProvidersRoutes } from './http/admin/ai-providers.routes';
import { createWebSearchAdminRoutes } from './http/admin/web-search.routes';
import { createRuntimeRoutes } from './http/admin/runtime.routes';
import { createAnalyticsRoutes } from './http/admin/analytics.routes';
import { createTokenUsageRoutes } from './http/admin/token-usage.routes';
import { createSpendRoutes } from './http/admin/spend.routes';
import { createProxyPolicyRoutes } from './http/admin/proxy-policy.routes';
import { createProxyRoutes } from './http/admin/proxy.routes';
import { createLlmProxyRoutes } from './http/llm/llm-proxy.routes';
import { createDesktopAuthRoutes } from './http/desktop/desktop-auth.routes';
import { createDesktopThreadsRoutes } from './http/desktop/desktop-threads.routes';
import { createTraceIngestRoutes } from './http/desktop/trace-ingest.routes';
import { ExecutionRepository } from './infrastructure/persistence/execution.repository';
import { createDesktopWsGateway } from './http/desktop/desktop-ws.gateway';
import { createAirnoteRoutes } from './http/airnote/airnote.routes';
import { createGatewayRoutes } from './http/gateway/gateway.routes';
import { IngestionWorker } from './application/ingestion/ingestion.worker';
import { LarkIngressWorker } from './application/lark-ingress/lark-ingress.worker';
import { PersonaLearningWorker } from './application/persona-learning/persona-learning.worker';
import { ManagerTeachWorker } from './application/persona-learning/manager-teach.worker';
import { createManagerTeachRoutes } from './http/desktop/manager-teach.routes';

export const createServer = (c: Container) => {
  const app = express();
  const allowedOrigins = new Set(
    [
      c.env.APP_BASE_URL,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
      // Divo Desktop (Tauri) — Vite dev server
      'http://localhost:1420',
      'http://127.0.0.1:1420',
      // Divo Desktop (Tauri) — packaged WebView origins
      'tauri://localhost',
      'http://tauri.localhost',
    ].filter(Boolean),
  );

  const larkWebhookDeps: LarkWebhookDeps = {
    adapter:               c.larkAdapter,
    engine:                c.engine,
    channelIdentityRepo:   c.channelIdentityRepo,
    conversationRepo:      c.conversationRepo,
    ingressReceiptRepo:    c.ingressReceiptRepo,
    ingressQueue:          c.larkIngressQueue,
    logger:                c.logger,
    env:                   c.env,
    approvalGate:          c.approvalGate,
    approvalCardHandler:   c.approvalCardHandler,
    knowledgeShareService: c.knowledgeShareService,
    shareResolverService:  c.shareResolverService,
    ...(c.mem0Service ? { mem0: c.mem0Service } : {}),
    larkOAuthService:      c.larkOAuthService,
    connectionRepo:        c.integrationConnectionRepo,
    cache:                 c.memoryCache,
    serializer:            c.chatSerializer,
    chatContextService:    c.chatContextService,
    channelDeliveryRepo:   c.channelDeliveryRepo,
    laneLeaseHolder:       c.laneLeaseHolder,
    busyNotices:           c.busyLaneNotices,
    batchingEnabled:       c.env.LARK_MESSAGE_BATCHING === 'on',
    prisma:                c.prisma,
    larkContactsClient:    c.larkContactsClient,
  };

  const larkIngressWorker = new LarkIngressWorker({
    redisUrl: c.queueRedisUrl,
    queue: c.larkIngressQueue,
    receiptRepo: c.ingressReceiptRepo,
    processReceipt: receipt => processAcceptedLarkReceipt(receipt, larkWebhookDeps),
    logger: c.logger,
  });
  larkIngressWorker.start();

  // Boot BullMQ ingestion worker (queue lives in container, shared with webhook routes)
  const ingestionWorker = new IngestionWorker({
    redisUrl:         c.queueRedisUrl,   // isolated BullMQ connection → REDIS_QUEUE_URL
    queueName:        c.env.REDIS_INGESTION_QUEUE_NAME,
    ingestionService: c.ingestionService,
    larkAdapter:      c.larkAdapter,
    env:              c.env,
    logger:           c.logger,
    chatContext:      c.chatContextService,
    concurrency:      c.env.INGESTION_WORKER_CONCURRENCY,
    summaryModel:     c.model,
  });
  ingestionWorker.start();

  // Manager persona promotion remains independent from memory, skills, RBAC,
  // and runtime prompt delivery. P5 adds a separate read-only delivery path.
  const personaLearningWorker = new PersonaLearningWorker({
    redisUrl: c.queueRedisUrl,
    queueName: c.env.REDIS_PERSONA_LEARNING_QUEUE_NAME,
    service: c.personaLearningService,
    promotionService: c.personaLearningPromotionService,
    logger: c.logger,
    concurrency: c.env.PERSONA_LEARNING_WORKER_CONCURRENCY,
  });
  personaLearningWorker.start();

  const managerTeachWorker = new ManagerTeachWorker({
    redisUrl: c.queueRedisUrl,
    queueName: c.env.REDIS_MANAGER_TEACH_QUEUE_NAME,
    service: c.managerTeachService,
    logger: c.logger,
    concurrency: c.env.MANAGER_TEACH_WORKER_CONCURRENCY,
  });
  managerTeachWorker.start();

  c.scheduledWorkflowService.start();

  const runCloudinaryCleanup = () => {
    void c.cloudinaryAdapter.cleanupExpiredExports({
      ttlSeconds: c.env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
    }).catch((error) => {
      c.logger.warn('cloudinary.cleanup.temp_exports.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  runCloudinaryCleanup();
  const cloudinaryCleanupTimer = setInterval(
    runCloudinaryCleanup,
    c.env.CLOUDINARY_TEMP_EXPORT_CLEANUP_INTERVAL_SECONDS * 1000,
  );
  cloudinaryCleanupTimer.unref?.();

  // Run-trace retention (Track A): prune detailed ExecutionEvent + StepResult
  // payloads past the window; AiTokenUsage (cost history) is never pruned.
  const executionRepoForRetention = new ExecutionRepository(c.prisma);
  const runTraceRetention = () => {
    const cutoff = new Date(Date.now() - c.env.TRACE_RETENTION_DAYS * 86_400_000);
    void executionRepoForRetention.pruneExpiredDetail(cutoff)
      .then((pruned) => {
        if (pruned.events > 0 || pruned.steps > 0) {
          c.logger.info('trace.retention.pruned', {
            events: pruned.events,
            steps:  pruned.steps,
            cutoff: cutoff.toISOString(),
          });
        }
      })
      .catch((error) => {
        c.logger.warn('trace.retention.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  runTraceRetention();
  const traceRetentionTimer = setInterval(
    runTraceRetention,
    c.env.TRACE_RETENTION_INTERVAL_HOURS * 3_600_000,
  );
  traceRetentionTimer.unref?.();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, x-company-id');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

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
  // Use req.originalUrl (always the full path) — req.path gets stripped by sub-routers
  // and would show just "/me" instead of "/api/admin/auth/me" in the finish callback.
  app.use((req, res, next) => {
    const start    = process.hrtime.bigint();
    const fullPath = req.originalUrl.split('?')[0] ?? req.originalUrl;
    c.logger.debug('http.request', {
      method:    req.method,
      path:      fullPath,
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
        path:      fullPath,
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
    '/api/admin/auth',
    createAdminAuthRoutes({
      prisma: c.prisma,
      env: c.env,
      auditService: c.auditService,
      logger: c.logger,
    }),
  );

  app.use(
    '/admin',
    createAdminPermissionRoutes({
      toolPermRepo:    c.toolPermRepo,
      toolActionRepo:  c.toolActionRepo,
      deptToolPermRepo: c.deptToolPermRepo,
      permissions:     c.permissions,
      logger:          c.logger,
      auditService:    c.auditService,
      permissionWrites: new PermissionWriteService({
        toolActionRepo: c.toolActionRepo,
        deptToolPermRepo: c.deptToolPermRepo,
        deptUserOverrideRepo: c.deptUserOverrideRepo,
        permissions: c.permissions,
        auditService: c.auditService,
        toolRegistry: c.toolRegistry,
      }),
    }),
  );

  app.use(
    '/webhooks/lark',
    createLarkWebhookRoutes(larkWebhookDeps),
  );

  // Google OAuth connect + callback
  app.use(
    '/api/google/auth',
    createGoogleAuthRoutes({
      googleOAuthService:    c.googleOAuthService,
      connectionRepo:        c.integrationConnectionRepo,
      cache:                 c.memoryCache,   // nonces → REDIS_MEMORY_URL
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
      cache:              c.memoryCache,    // nonces → REDIS_MEMORY_URL
      logger:             c.logger,
      env:                c.env,
      frontendBaseUrl:    c.env.APP_BASE_URL,
    }),
  );

  // Lark user OAuth connect + callback
  app.use(
    '/api/lark/auth',
    createLarkAuthRoutes({
      larkOAuthService:    c.larkOAuthService,
      connectionRepo:      c.integrationConnectionRepo,
      cache:               c.memoryCache,   // nonces → REDIS_MEMORY_URL
      logger:              c.logger,
      appId:               c.env.LARK_APP_ID,
      appSecret:           c.env.LARK_APP_SECRET,
      apiBase:             c.env.LARK_API_BASE_URL,
      channelIdentityRepo: c.channelIdentityRepo,
      // Shares the webhook's deps so the replayed turn runs through exactly the
      // same lane, lease, and delivery path as any other message.
      onLinked:            pendingEvent =>
        replayLarkMessageAfterLogin(pendingEvent, larkWebhookDeps),
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
  app.use(
    '/api/admin/executions',
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
    '/api/gateway',
    memberAuth,
    createGatewayRoutes({
      dispatcher: c.gatewayDispatcher,
      logger:     c.logger,
    }),
  );

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

  // Desktop auth (Lark OAuth, handoff, session management)
  app.use(
    '/api/desktop/auth',
    createDesktopToolsRoutes({
      prisma:                 c.prisma,
      memberJwtSecret:        c.env.MEMBER_JWT_SECRET,
      logger:                 c.logger,
      permissions:            c.permissions,
      toolActionRepo:         c.toolActionRepo,
      toolPermRepo:           c.toolPermRepo,
      companyRoleRepo:        c.companyRoleRepo,
      deptToolPermRepo:       c.deptToolPermRepo,
      deptUserOverrideRepo:   c.deptUserOverrideRepo,
      connectionRepo:         c.integrationConnectionRepo,
      auditService:           c.auditService,
      toolRegistry:           c.toolRegistry,
      serperConnectionRepo:   c.companySerperConnectionRepo,
      serperService:          c.companySerperService,
      omsConnectionRepo:      c.companyOmsConnectionRepo,
      omsSiteDataService:     c.companyOmsSiteDataService,
    }),
  );
  app.use(
    '/api/desktop',
    createDesktopDepartmentRoutes({
      prisma:          c.prisma,
      memberJwtSecret: c.env.MEMBER_JWT_SECRET,
      logger:          c.logger,
      service:         c.desktopDepartmentManagementService,
    }),
  );
  app.use(
    '/api/desktop/auth',
    createDesktopAuthRoutes({
      prisma:                 c.prisma,
      larkOAuthService:       c.larkOAuthService,
      googleOAuthService:     c.googleOAuthService,
      canvaMcpOAuthService:   c.canvaMcpOAuthService,
      airtableMcpOAuthService: c.airtableMcpOAuthService,
      zohoTokenService:       c.zohoTokenService,
      zohoConnectionRepo:     c.zohoConnectionRepo,
      connectionRepo:         c.integrationConnectionRepo,
      permissions:            c.permissions,
      skillCatalog:           c.skillCatalog,
      skillAccessEnforcement: c.skillAccessEnforcement,
      managerPersonaRuntime:  c.managerPersonaRuntimeService,
      logger:                 c.logger,
      env:                    c.env,
      memberJwtSecret:        c.env.MEMBER_JWT_SECRET,
      backendPublicUrl:       c.env.BACKEND_PUBLIC_URL,
      sessionTtlMinutes:      480,
    }),
  );

  // Desktop threads CRUD (member auth — applied inside router)
  app.use(
    '/api/desktop/threads',
    createDesktopThreadsRoutes({
      prisma:          c.prisma,
      logger:          c.logger,
      memberJwtSecret: c.env.MEMBER_JWT_SECRET,
    }),
  );

  // Explicit manager Teach recording ingestion. The router owns member auth
  // and enforces the live department MANAGER membership on every new session.
  app.use(
    '/api/desktop/teach',
    createManagerTeachRoutes({
      prisma: c.prisma,
      memberJwtSecret: c.env.MEMBER_JWT_SECRET,
      logger: c.logger,
      service: c.managerTeachService,
      revisions: c.managerPersonaRevisionService,
      uploadDir: c.managerTeachUploadDir,
      maxVideoBytes: c.env.MANAGER_TEACH_MAX_VIDEO_MB * 1_024 * 1_024,
    }),
  );

  // Desktop/PI run-trace ingest (Track A — member auth). Current clients share
  // a run ID with the proxy and declare which source owns token accounting.
  app.use(
    '/api/desktop/trace',
    memberAuth,
    createTraceIngestRoutes({
      prisma:         c.prisma,
      logger:         c.logger,
      proxyOwnsTrace: c.env.PROXY_OWNS_TRACE,
      personaLearning: c.personaLearningService,
    }),
  );

  // LLM proxy (Guardrails) — desktop → backend → DeepSeek. Mounts whenever the
  // flag is on; the key is resolved per-request by the store (company → platform →
  // env). No key configured ⇒ the route returns 503 "not configured", never 404.
  // PI holds no key — it authenticates with its member token.
  if (c.env.LLM_PROXY_ENABLED) {
    app.use(
      '/api/llm',
      memberAuth,
      createLlmProxyRoutes({
        logger:  c.logger,
        store:   c.proxyKeyStore,
        service: c.llmProxyService,
        baseUrl: c.env.DEEPSEEK_BASE_URL,
        apiKeyExhaustion: c.apiKeyExhaustionNotifier,
      }),
    );
    c.logger.info('llm-proxy.enabled', { baseUrl: c.env.DEEPSEEK_BASE_URL, canEncrypt: c.proxyKeyStore.canEncrypt() });
  }

  // AirNote channel (SSE chat + thread recovery)
  app.use(
    '/api/airnote',
    createAirnoteRoutes({
      prisma:              c.prisma,
      logger:              c.logger,
      engine:              c.engine,
      chatSerializer:      c.chatSerializer,
      larkOAuthService:    c.larkOAuthService,
      channelIdentityRepo: c.channelIdentityRepo,
      approvalGate:        c.approvalGate,
    }),
  );

  // Agent definition + channel mapping CRUD (admin auth required)
  app.use(
    '/api',
    adminAuth,
    createAgentsRoutes({
      agentAdminService: c.agentAdminService,
      logger:            c.logger,
    }),
  );

  // Department admin CRUD
  app.use(
    '/api/admin/departments',
    adminAuth,
    createDepartmentRoutes({
      deptAdminService: c.departmentAdminService,
      auditService:      c.auditService,
      logger:           c.logger,
    }),
  );

  // Skill Registry admin (Skills Lab)
  app.use(
    '/api/admin/skill-registry',
    adminAuth,
    createSkillRegistryRoutes({
      skillRegistryService: c.skillRegistryAdminService,
      auditService:         c.auditService,
      logger:               c.logger,
    }),
  );

  app.use(
    '/api/admin/memories',
    adminAuth,
    createMemoryRoutes({ mem0: c.mem0Service, logger: c.logger }),
  );

  // Company admin surface (members, directory, invites, onboarding, tool-permissions)
  const companyRoutes = createCompanyRoutes({
    prisma: c.prisma,
    logger: c.logger,
    env: c.env,
    cache: c.memoryCache,
    larkOAuthService: c.larkOAuthService,
    zohoTokenService: c.zohoTokenService,
    zohoConnectionRepo: c.zohoConnectionRepo,
    larkContactsClient: c.larkContactsClient,
  });
  app.use('/api/admin/company', adminAuth, companyRoutes);
  // Alias: GET /api/admin/members → GET /api/admin/company/members (used by OverviewPage)
  // The company router handles /members as a sub-path, so rewrite the URL before dispatching.
  app.get('/api/admin/members', adminAuth, (req, res, next) => {
    req.url = '/members';
    companyRoutes(req, res, next);
  });

  // Audit logs
  app.use('/api/admin/audit', adminAuth, createAuditRoutes({ auditService: c.auditService, logger: c.logger }));

  // Admin controls
  app.use('/api/admin/controls', adminAuth, createControlsRoutes({ prisma: c.prisma, logger: c.logger, env: c.env, audit: c.auditService }));

  // RBAC permissions
  app.use('/api/admin/rbac', adminAuth, createRbacRoutes({ prisma: c.prisma, logger: c.logger }));

  // AI model target configs
  app.use('/api/admin/ai-models', adminAuth, createAiModelsRoutes({ prisma: c.prisma, logger: c.logger }));

  // AI provider connections
  app.use('/api/admin/ai-providers', adminAuth, createAiProvidersRoutes({
    prisma: c.prisma,
    env: c.env,
    logger: c.logger,
    invalidateGatewayProviderCache: c.invalidateGatewayProviderCache,
  }));

  // Company-owned Serper connection metadata and Divo-observed usage.
  app.use('/api/admin/web-search', adminAuth, createWebSearchAdminRoutes({ prisma: c.prisma }));

  // Runtime task list (delegates to execution query service)
  app.use('/api/admin/runtime', adminAuth, createRuntimeRoutes({ executionQueryService: c.executionQueryService, logger: c.logger }));

  // Analytics overview (dashboard aggregations)
  app.use('/api/admin/analytics', adminAuth, createAnalyticsRoutes({ prisma: c.prisma, logger: c.logger }));

  // Token usage (per-member consumption + limits)
  app.use('/api/admin/token-usage', adminAuth, createTokenUsageRoutes({ prisma: c.prisma, logger: c.logger }));

  app.use('/api/admin/spend', adminAuth, createSpendRoutes({ prisma: c.prisma, logger: c.logger }));

  // Per-member proxy guardrails (block / budget / rate / allowed models).
  app.use('/api/admin/proxy-policy', adminAuth, createProxyPolicyRoutes({ prisma: c.prisma, logger: c.logger }));

  // Proxy control plane (Guardrails) — key store + status.
  app.use('/api/admin/proxy', adminAuth, createProxyRoutes({
    prisma: c.prisma, store: c.proxyKeyStore, logger: c.logger, enabled: c.env.LLM_PROXY_ENABLED, upstream: c.env.DEEPSEEK_BASE_URL,
  }));

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Error boundary
  app.use(createErrorBoundary(c.logger) as any);

  return app;
};
