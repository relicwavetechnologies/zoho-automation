import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from './composition';
import { createHealthRoutes } from './http/health.routes';
import { createErrorBoundary } from './http/error-boundary';
import {
  createLarkWebhookRoutes,
  processAcceptedLarkReceipt,
  replayLarkMessageAfterLogin,
  runPiAndDeliver,
  type LarkWebhookDeps,
} from './infrastructure/channels/lark/lark.webhook.routes';
import { createAdminAuthRoutes } from './http/admin/admin-auth.routes';
import { createAdminPermissionRoutes } from './http/admin/permission.routes';
import { createGoogleAuthRoutes } from './http/google/google-auth.routes';
import { createGoogleConnectionRoutes } from './http/google/google-connection.routes';
import { createGmailPubSubRoutes } from './http/google/gmail-pubsub.routes';
import { GooglePubSubPushVerifier } from './infrastructure/google/google-pubsub-push-auth';
import { createZohoAuthRoutes } from './http/zoho/zoho-auth.routes';
import { createLarkAuthRoutes } from './http/lark/lark-auth.routes';
import { createExecutionRoutes } from './http/executions/execution.routes';
import { createAdminAuthMiddleware } from './http/middleware/admin-auth.middleware';
import { createMemberAuthMiddleware, MEMBER_SESSION_TTL_MINUTES } from './http/middleware/member-auth.middleware';
import { createDesktopToolsRoutes } from './http/desktop/desktop-tools.routes';
import { createMailAutomationsRoutes } from './http/mail/mail-automations.routes';
import { createDesktopDepartmentRoutes } from './http/desktop/desktop-departments.routes';
import { createDesktopApprovalRoutes } from './http/desktop/desktop-approvals.routes';
import { createDesktopActivityRoutes, createDesktopTeamActivityRoutes } from './http/desktop/desktop-activity.routes';
import { createDepartmentRoutes } from './http/admin/departments.routes';
import { createSkillRegistryRoutes } from './http/admin/skill-registry.routes';
import { createMemoryRoutes } from './http/admin/memory.routes';
import { createCompanyRoutes } from './http/admin/company.routes';
import { createAuditRoutes } from './http/admin/audit.routes';
import { createControlsRoutes } from './http/admin/controls.routes';
import { createRbacRoutes } from './http/admin/rbac.routes';
import { createAiModelsRoutes } from './http/admin/ai-models.routes';
import { createToolRegistryRoutes } from './http/admin/tool-registry.routes';
import { createWebSearchAdminRoutes } from './http/admin/web-search.routes';
import { createRuntimeRoutes } from './http/admin/runtime.routes';
import { createAnalyticsRoutes } from './http/admin/analytics.routes';
import { createTokenUsageRoutes } from './http/admin/token-usage.routes';
import { createSpendRoutes } from './http/admin/spend.routes';
import { createProxyPolicyRoutes } from './http/admin/proxy-policy.routes';
import { createProxyRoutes } from './http/admin/proxy.routes';
import { createLlmProxyRoutes } from './http/llm/llm-proxy.routes';
import { createDesktopAuthRoutes } from './http/desktop/desktop-auth.routes';
import { createTraceIngestRoutes } from './http/desktop/trace-ingest.routes';
import { ExecutionRepository } from './infrastructure/persistence/execution.repository';
import { createGatewayRoutes } from './http/gateway/gateway.routes';
import { DataExportWorker } from './application/data-export/data-export.worker';
import { LarkIngressWorker } from './application/lark-ingress/lark-ingress.worker';
import { GoogleConnectionContinuationWorker } from './application/connections/google-connection-continuation';
import { getGmailPubSubConfig } from './config/env';
import { PersonaLearningWorker } from './application/persona-learning/persona-learning.worker';
import { KnowledgeLearningWorker } from './application/knowledge/knowledge-learning.worker';
import { ManagerTeachWorker } from './application/persona-learning/manager-teach.worker';
import { KnowledgeReviewDecisionWorker } from './application/knowledge/knowledge-review-decision.worker';
import { createManagerTeachRoutes } from './http/desktop/manager-teach.routes';
import { createKnowledgeFileRoutes } from './http/desktop/knowledge-files.routes';
import { LarkFileClient } from './infrastructure/channels/lark/clients/lark-file.client';
import { ElevenLabsTranscriptionClient } from './infrastructure/ai/transcription/elevenlabs-transcription.client';

/** Where the model proxy is mounted. Named because the body parser exempts it. */
const LLM_PROXY_MOUNT_PATH = '/api/llm';

/** Vision requests can contain several inlined images; other routes stay at 2 MB. */
const LLM_PROXY_BODY_LIMIT = '24mb';

export type DivoServerApplication = Express & {
  shutdown(): Promise<void>;
};

export const createServer = (c: Container): DivoServerApplication => {
  const app = express() as DivoServerApplication;
  const gmailPubsubConfig = getGmailPubSubConfig(c.env);
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
  const voiceTranscriber = c.env.ELEVEN_LABS_API_KEY
    ? new ElevenLabsTranscriptionClient({ apiKey: c.env.ELEVEN_LABS_API_KEY })
    : undefined;
  const voiceFileClient = voiceTranscriber
    ? new LarkFileClient(c.env, c.logger)
    : undefined;
  // Built in composition so the scheduled-workflow poller shares this exact
  // instance; two runtimes would mean two lease issuers for one container.
  const larkPiRuntime = c.larkPiRuntime;

  const larkWebhookDeps: LarkWebhookDeps = {
    adapter:               c.larkAdapter,
    piRuntime:             larkPiRuntime,
    channelIdentityRepo:   c.channelIdentityRepo,
    conversationRepo:      c.conversationRepo,
    ingressReceiptRepo:    c.ingressReceiptRepo,
    ingressQueue:          c.larkIngressQueue,
    logger:                c.logger,
    env:                   c.env,
    appBaseUrl:            c.env.APP_BASE_URL,
    approvalGate:          c.approvalGate,
    approvalCardHandler:   c.approvalCardHandler,
    dataExportCardHandler: c.dataExportCardHandler,
    knowledgeReviewService: c.larkKnowledgeReviewService,
    larkOAuthService:      c.larkOAuthService,
    connectionRepo:        c.integrationConnectionRepo,
    cache:                 c.ephemeralCache,
    serializer:            c.chatSerializer,
    chatContextService:    c.chatContextService,
    groupContextHydrator:  c.groupContextHydrator,
    channelDeliveryRepo:   c.channelDeliveryRepo,
    laneLeaseHolder:       c.laneLeaseHolder,
    busyNotices:           c.busyLaneNotices,
    batchingEnabled:       c.env.LARK_MESSAGE_BATCHING === 'on',
    prisma:                c.prisma,
    larkContactsClient:    c.larkContactsClient,
    ...(voiceFileClient && voiceTranscriber
      ? { voiceFileClient, voiceTranscriber }
      : {}),
  };

  const larkIngressWorker = new LarkIngressWorker({
    redisUrl: c.queueRedisUrl,
    queue: c.larkIngressQueue,
    receiptRepo: c.ingressReceiptRepo,
    processReceipt: receipt => processAcceptedLarkReceipt(receipt, larkWebhookDeps),
    logger: c.logger,
  });
  larkIngressWorker.start();

  const googleConnectionContinuationWorker =
    new GoogleConnectionContinuationWorker({
      redisUrl: c.queueRedisUrl,
      queue: c.googleConnectionContinuationQueue,
      intentRepo: c.connectionAuthorizationRepo,
      identityRepo: c.channelIdentityRepo,
      connectionRepo: c.integrationConnectionRepo,
      resumeDataExport: c.resumeDataExportAfterGoogleConnection,
      runPi: input => runPiAndDeliver({
        ...input,
        deps: {
          adapter: input.channelAdapter,
          piRuntime: larkPiRuntime,
          conversationRepo: c.conversationRepo,
          channelDeliveryRepo: c.channelDeliveryRepo,
          groupContextHydrator: c.groupContextHydrator,
        },
        log: c.logger,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
        rethrowRuntimeFailureAfterDelivery: true,
      }),
      channelAdapter: c.larkAdapter,
      laneLeaseHolder: c.laneLeaseHolder,
      logger: c.logger,
    });
  googleConnectionContinuationWorker.start();
  const recoverGoogleExchanges = () => {
    const staleBefore = new Date(Date.now() - 2 * 60_000);
    void c.googleConnectionAuthorization
      .reconcileStaleExchanges(staleBefore)
      .catch(error => {
        c.logger.warn('google.authorization.exchange_reconcile_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  let googleExchangeRecoveryTimer: NodeJS.Timeout | undefined;
  if (c.env.DIVO_AUTONOMOUS_WORKERS_ENABLED) {
    recoverGoogleExchanges();
    googleExchangeRecoveryTimer = setInterval(
      recoverGoogleExchanges,
      60_000,
    );
    googleExchangeRecoveryTimer.unref?.();
    c.mailOpsWorker.start();
  }

  const dataExportWorker = new DataExportWorker({
    redisUrl: c.queueRedisUrl,
    sources: c.dataExportSources,
    sink: c.googleWorkspaceExportSink,
    identityRepo: c.channelIdentityRepo,
    permissions: c.permissions,
    resolveGoogleAuth: c.resolveGoogleExportAuth,
    larkAdapter: c.larkAdapter,
    conversationHistory: c.conversationRepo,
    logger: c.logger,
  });
  dataExportWorker.start();

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

  let knowledgeLearningWorker: KnowledgeLearningWorker | undefined;
  if (c.env.KNOWLEDGE_LEARNING_ENABLED) {
    knowledgeLearningWorker = new KnowledgeLearningWorker({
      redisUrl: c.queueRedisUrl,
      queueName: c.env.REDIS_KNOWLEDGE_LEARNING_QUEUE_NAME,
      service: c.knowledgeLearningService,
      logger: c.logger,
      concurrency: c.env.KNOWLEDGE_LEARNING_WORKER_CONCURRENCY,
    });
    knowledgeLearningWorker.start();
  }

  const managerTeachWorker = new ManagerTeachWorker({
    redisUrl: c.queueRedisUrl,
    queueName: c.env.REDIS_MANAGER_TEACH_QUEUE_NAME,
    service: c.managerTeachService,
    logger: c.logger,
    concurrency: c.env.MANAGER_TEACH_WORKER_CONCURRENCY,
  });
  managerTeachWorker.start();

  const knowledgeReviewDecisionWorker = new KnowledgeReviewDecisionWorker({
    redisUrl: c.queueRedisUrl,
    service: c.larkKnowledgeReviewService,
    logger: c.logger,
  });
  knowledgeReviewDecisionWorker.start();

  const drainKnowledgeOutbox = () => {
    void c.knowledgeProjections.drain().catch(error => {
      c.logger.warn('knowledge.projection.drain_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  drainKnowledgeOutbox();
  const knowledgeProjectionTimer = setInterval(
    drainKnowledgeOutbox,
    c.env.KNOWLEDGE_PROJECTION_POLL_INTERVAL_MS,
  );
  knowledgeProjectionTimer.unref?.();

  const cleanupStagedKnowledgeFiles = () => {
    void c.knowledgeFileService.cleanupExpired().catch(error => {
      c.logger.warn('knowledge_file.cleanup.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  cleanupStagedKnowledgeFiles();
  const knowledgeFileCleanupTimer = setInterval(
    cleanupStagedKnowledgeFiles,
    c.env.KNOWLEDGE_FILE_CLEANUP_INTERVAL_SECONDS * 1_000,
  );
  knowledgeFileCleanupTimer.unref?.();

  if (c.env.DIVO_AUTONOMOUS_WORKERS_ENABLED) {
    c.scheduledWorkflowService.start();
  }

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
  const parseJsonBody = express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      // Attach raw body for HMAC verification; use unknown-cast to avoid module augmentation.
      (req as unknown as Record<string, unknown>)['rawBody'] = buf.toString('utf8');
    },
  });
  // The model proxy is exempt because a vision request carries the picture.
  // 2mb is right for every other route and far too small for this one: Pi inlines
  // an image up to 4.5MB of base64 (`DEFAULT_MAX_BYTES` in its image resizer),
  // and a 413 raised here never reaches the proxy — the run just fails with
  // advice about truncating tool results, which cannot help an image.
  app.use((req, res, next) =>
    req.path.startsWith(LLM_PROXY_MOUNT_PATH) ? next() : parseJsonBody(req, res, next));
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
  app.use('/health', createHealthRoutes(c.prisma, {
    ...(c.env.LARK_CARD_CALLBACK_URL
      ? { larkCardCallbackUrl: c.env.LARK_CARD_CALLBACK_URL }
      : {}),
    knowledgeOperations: c.knowledgeOperations,
  }));

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
      toolPermRepo: c.toolPermRepo,
      permissions:  c.permissions,
      logger:       c.logger,
      auditService: c.auditService,
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
      cache:                 c.ephemeralCache,   // nonces → REDIS_MEMORY_URL
      logger:                c.logger,
      frontendBaseUrl:       c.env.APP_BASE_URL,
    }),
  );

  app.use(
    '/api/google/connection',
    createGoogleConnectionRoutes({
      authorization: c.googleConnectionAuthorization,
      continuationQueue: c.googleConnectionContinuationQueue,
      logger: c.logger,
    }),
  );
  if (gmailPubsubConfig) {
    app.use(
      '/api/google/gmail-pubsub',
      createGmailPubSubRoutes({
        verifier: new GooglePubSubPushVerifier({
          audience: gmailPubsubConfig.pushAudience,
          serviceAccountEmail: gmailPubsubConfig.pushServiceAccount,
        }),
        expectedSubscription: gmailPubsubConfig.subscription,
        mailOpsRepo: c.mailOpsRepo,
        wakeMailOps: () => {
          if (c.env.DIVO_AUTONOMOUS_WORKERS_ENABLED) c.mailOpsWorker.wake();
        },
        logger: c.logger,
      }),
    );
  } else {
    c.logger.warn('gmail.pubsub.disabled', {
      reason: 'GOOGLE_PUBSUB_TOPIC, SUBSCRIPTION, PUSH_AUDIENCE, or PUSH_SERVICE_ACCOUNT is missing',
    });
  }

  // Zoho OAuth connect + callback
  app.use(
    '/api/zoho/auth',
    createZohoAuthRoutes({
      zohoTokenService:   c.zohoTokenService,
      zohoConnectionRepo: c.zohoConnectionRepo,
      cache:              c.ephemeralCache,    // nonces → REDIS_MEMORY_URL
      logger:             c.logger,
      env:                c.env,
      frontendBaseUrl:    c.env.APP_BASE_URL,
    }),
  );

  // Shared by every route that acts for a signed-in person, including the
  // Lark identity link below — one session type, one middleware.
  const memberAuth = createMemberAuthMiddleware({
    prisma:    c.prisma,
    jwtSecret: c.env.MEMBER_JWT_SECRET,
    logger:    c.logger,
  });

  // Lark user OAuth connect + callback
  app.use(
    '/api/lark/auth',
    createLarkAuthRoutes({
      larkOAuthService:    c.larkOAuthService,
      connectionRepo:      c.integrationConnectionRepo,
      cache:               c.ephemeralCache,   // nonces → REDIS_MEMORY_URL
      logger:              c.logger,
      appId:               c.env.LARK_APP_ID,
      appSecret:           c.env.LARK_APP_SECRET,
      apiBase:             c.env.LARK_API_BASE_URL,
      prisma:              c.prisma,
      memberSessionTtlMinutes: MEMBER_SESSION_TTL_MINUTES,
      channelIdentityRepo: c.channelIdentityRepo,
      memberAuth,
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
    // The web app signs in once and holds one session. Admin routes accept it
    // only when the person's live membership says COMPANY_ADMIN or SUPER_ADMIN.
    memberJwtSecret: c.env.MEMBER_JWT_SECRET,
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
  const piRuntimeMemberAuth = createMemberAuthMiddleware({
    prisma:    c.prisma,
    jwtSecret: c.env.MEMBER_JWT_SECRET,
    logger:    c.logger,
    allowPiRuntimeLease: () => true,
  });
  app.use(
    '/api/gateway',
    piRuntimeMemberAuth,
    createGatewayRoutes({
      dispatcher: c.gatewayDispatcher,
      logger:     c.logger,
    }),
  );
  app.use(
    '/api/knowledge/files',
    piRuntimeMemberAuth,
    createKnowledgeFileRoutes({
      files: c.knowledgeFileService,
      logger: c.logger,
      maxBytes: c.env.KNOWLEDGE_FILE_MAX_MB * 1_024 * 1_024,
    }),
  );

  app.use(
    '/api/desktop',
    createDesktopApprovalRoutes({
      prisma:          c.prisma,
      memberJwtSecret: c.env.MEMBER_JWT_SECRET,
      logger:          c.logger,
      inbox:           c.approvalInbox,
    }),
  );

  // A member's own usage and runs. Pinned to the signed-in user inside the
  // router; there is no userId parameter to get wrong.
  app.use(
    '/api/desktop/me',
    createDesktopActivityRoutes({
      prisma:          c.prisma,
      memberJwtSecret: c.env.MEMBER_JWT_SECRET,
      logger:          c.logger,
    }),
  );
  // A manager's view of their own department's cost. Separate mount because the
  // path is department-scoped rather than /me, and its authority check is the
  // department one rather than "this is you".
  app.use(
    '/api/desktop',
    createDesktopTeamActivityRoutes({
      prisma:          c.prisma,
      memberJwtSecret: c.env.MEMBER_JWT_SECRET,
      logger:          c.logger,
    }),
  );
  // Mounted under /auth because that is the base the desktop's
  // `divo_desktop_json_request` helper prefixes onto every tool path. Moving it
  // to /api/desktop takes GET /api/desktop/auth/tools off the air, and the
  // desktop reads that 401 as an expired session.
  // Read-only view of a member's own mail rules and mailbox health. Mounted
  // beside the other personal endpoints because it answers the same question
  // they do — what is Divo doing on my behalf, and is it working.
  app.use(
    '/api/mail-automations',
    createMailAutomationsRoutes({
      readRepo: c.mailOpsReadRepo,
      memberAuth: {
        prisma: c.prisma,
        jwtSecret: c.env.MEMBER_JWT_SECRET,
        logger: c.logger,
      },
      logger: c.logger,
    }),
  );

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
  // Desktop auth (Lark OAuth, handoff, session management)
  app.use(
    '/api/desktop/auth',
    createDesktopAuthRoutes({
      prisma:                 c.prisma,
      larkOAuthService:       c.larkOAuthService,
      googleOAuthService:     c.googleOAuthService,
      canvaMcpOAuthService:   c.canvaMcpOAuthService,
      airtableMcpOAuthService: c.airtableMcpOAuthService,
      aitableKeyVerifier:      c.aitableKeyVerifier,
      zohoTokenService:       c.zohoTokenService,
      zohoConnectionRepo:     c.zohoConnectionRepo,
      connectionRepo:         c.integrationConnectionRepo,
      permissions:            c.permissions,
      skillCatalog:           c.skillCatalog,
      skillAccessEnforcement: c.skillAccessEnforcement,
      managerPersonaRuntime:  c.managerPersonaRuntimeService,
      ...(c.memoryService ? { memory: c.memoryService } : {}),
      logger:                 c.logger,
      env:                    c.env,
      memberJwtSecret:        c.env.MEMBER_JWT_SECRET,
      backendPublicUrl:       c.env.BACKEND_PUBLIC_URL,
      sessionTtlMinutes:      MEMBER_SESSION_TTL_MINUTES,
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
    piRuntimeMemberAuth,
    createTraceIngestRoutes({
      prisma:         c.prisma,
      logger:         c.logger,
      proxyOwnsTrace: c.env.PROXY_OWNS_TRACE,
      personaLearning: c.personaLearningService,
      ...(c.env.KNOWLEDGE_LEARNING_ENABLED
        ? { knowledgeLearning: c.knowledgeLearningService }
        : {}),
    }),
  );

  // LLM proxy (Guardrails) — desktop/Lark → backend → selected provider. Mounts
  // whenever the flag is on; the provider key is resolved per request. No key
  // configured ⇒ the route returns 503 "not configured", never 404.
  // PI holds no key — it authenticates with its member token.
  if (c.env.LLM_PROXY_ENABLED) {
    app.use(
      LLM_PROXY_MOUNT_PATH,
      express.json({ limit: LLM_PROXY_BODY_LIMIT }),
      piRuntimeMemberAuth,
      createLlmProxyRoutes({
        logger:  c.logger,
        store:   c.proxyKeyStore,
        service: c.llmProxyService,
        baseUrls: { deepseek: c.env.DEEPSEEK_BASE_URL, openai: c.env.OPENAI_BASE_URL },
        apiKeyExhaustion: c.apiKeyExhaustionNotifier,
      }),
    );
    c.logger.info('llm-proxy.enabled', {
      deepseek: c.env.DEEPSEEK_BASE_URL,
      openai: c.env.OPENAI_BASE_URL,
      canEncrypt: c.proxyKeyStore.canEncrypt(),
    });
  }

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
    createMemoryRoutes({
      prisma: c.prisma,
      logger: c.logger,
      operations: c.knowledgeOperations,
      audit: c.auditService,
    }),
  );

  // Company admin surface (members, directory, invites, onboarding, tool-permissions)
  const companyRoutes = createCompanyRoutes({
    prisma: c.prisma,
    logger: c.logger,
    env: c.env,
    cache: c.ephemeralCache,
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

  // Registered governed tools, read by Skills Lab and the department editor.
  app.use('/api/admin/tool-registry', adminAuth, createToolRegistryRoutes({ prisma: c.prisma }));

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
    prisma: c.prisma, store: c.proxyKeyStore, logger: c.logger, enabled: c.env.LLM_PROXY_ENABLED,
    upstreams: { deepseek: c.env.DEEPSEEK_BASE_URL, openai: c.env.OPENAI_BASE_URL },
  }));

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Error boundary
  app.use(createErrorBoundary(c.logger) as any);

  let shutdownPromise: Promise<void> | undefined;
  app.shutdown = () => {
    shutdownPromise ??= (async () => {
      if (googleExchangeRecoveryTimer) clearInterval(googleExchangeRecoveryTimer);
      clearInterval(knowledgeProjectionTimer);
      clearInterval(knowledgeFileCleanupTimer);
      clearInterval(cloudinaryCleanupTimer);
      clearInterval(traceRetentionTimer);
      c.mailOpsWorker.stop();
      c.scheduledWorkflowService.stop();

      const errors: unknown[] = [];
      const closePhase = async (
        resources: readonly { name: string; close: () => Promise<void> }[],
      ): Promise<void> => {
        const settled = await Promise.allSettled(resources.map(resource => resource.close()));
        settled.forEach((result, index) => {
          if (result.status === 'fulfilled') return;
          const resource = resources[index];
          errors.push(result.reason);
          c.logger.error('server.resource_shutdown_failed', {
            resource: resource?.name ?? 'unknown',
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        });
      };

      // Workers must release their blocking BullMQ connections before the
      // producer queues and shared application Redis clients are closed.
      await closePhase([
        { name: 'lark-ingress-worker', close: () => larkIngressWorker.stop() },
        { name: 'google-continuation-worker', close: () => googleConnectionContinuationWorker.stop() },
        { name: 'data-export-worker', close: () => dataExportWorker.stop() },
        { name: 'persona-learning-worker', close: () => personaLearningWorker.stop() },
        ...(knowledgeLearningWorker
          ? [{ name: 'knowledge-learning-worker', close: () => knowledgeLearningWorker.stop() }]
          : []),
        { name: 'manager-teach-worker', close: () => managerTeachWorker.close() },
        { name: 'knowledge-review-worker', close: () => knowledgeReviewDecisionWorker.stop() },
      ]);
      await closePhase([
        { name: 'lark-ingress-queue', close: () => c.larkIngressQueue.close() },
        { name: 'google-continuation-queue', close: () => c.googleConnectionContinuationQueue.close() },
        { name: 'data-export-queue', close: () => c.dataExportQueue.close() },
        { name: 'persona-learning-queue', close: () => c.personaLearningQueue.close() },
        { name: 'knowledge-learning-queue', close: () => c.knowledgeLearningQueue.close() },
        { name: 'manager-teach-queue', close: () => c.managerTeachQueue.close() },
        { name: 'knowledge-review-queue', close: () => c.knowledgeReviewDecisionQueue.close() },
      ]);

      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more server resources failed to stop cleanly.');
      }
    })();
    return shutdownPromise;
  };

  return app;
};
