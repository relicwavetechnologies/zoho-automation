import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import type { Container } from './composition';
import { createHealthRoutes } from './http/health.routes';
import { createSiteIconRoutes } from './http/icons/site-icon.routes';
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
import { buildSignInConnectedCard } from './infrastructure/channels/lark/lark-signin';
import { createShopifyAuthRoutes } from './http/shopify/shopify-auth.routes';
import { createShopifyWebhookRoutes } from './http/shopify/shopify-webhook.routes';
import { createWhatsappWebhookRoutes } from './http/whatsapp/whatsapp.webhook.routes';
import { createRequireChatEnabled } from './http/desktop/web-chat-access.middleware';
import { createFollowUpRoutes } from './http/member/follow-ups.routes';
import { createBroadcastRoutes } from './http/member/broadcasts.routes';
import { ShopifyWebhookRepository } from './infrastructure/persistence/shopify-webhook.repository';
import { PrismaShopifyPrivacyRepository } from './infrastructure/persistence/shopify-privacy.repository';
import { drainExpiredShopifyPrivacyRequests } from './application/shopify/shopify-privacy-retention.service';
import { createExecutionRoutes } from './http/executions/execution.routes';
import { createAdminAuthMiddleware } from './http/middleware/admin-auth.middleware';
import { createMemberAuthMiddleware, MEMBER_SESSION_TTL_MINUTES } from './http/middleware/member-auth.middleware';
import { createDesktopToolsRoutes } from './http/desktop/desktop-tools.routes';
import { createMailAutomationsRoutes } from './http/mail/mail-automations.routes';
import { createMailGovernanceRoutes } from './http/mail/mail-governance.routes';
import { createDesktopDepartmentRoutes } from './http/desktop/desktop-departments.routes';
import { createDesktopApprovalRoutes } from './http/desktop/desktop-approvals.routes';
import { createDesktopSkillRoutes } from './http/desktop/desktop-skills.routes';
import { createDesktopActivityRoutes, createDesktopTeamActivityRoutes } from './http/desktop/desktop-activity.routes';
import { createDepartmentRoutes } from './http/admin/departments.routes';
import { createSkillRegistryRoutes } from './http/admin/skill-registry.routes';
import { createMemoryRoutes } from './http/admin/memory.routes';
import { createCompanyRoutes } from './http/admin/company.routes';
import { createAuditRoutes } from './http/admin/audit.routes';
import { createShopifyPrivacyRoutes } from './http/admin/shopify-privacy.routes';
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
import { createArtifactRoutes } from './http/member/artifacts.routes';
import { createMemberTaskRoutes } from './http/member/tasks.routes';
import { ExecutionRepository } from './infrastructure/persistence/execution.repository';
import { createGatewayRoutes } from './http/gateway/gateway.routes';
import { LarkIngressWorker } from './application/lark-ingress/lark-ingress.worker';
import { getGmailPubSubConfig } from './config/env';
import { PersonaLearningWorker } from './application/persona-learning/persona-learning.worker';
import { KnowledgeLearningWorker } from './application/knowledge/knowledge-learning.worker';
import { ManagerTeachWorker } from './application/persona-learning/manager-teach.worker';
import { KnowledgeReviewDecisionWorker } from './application/knowledge/knowledge-review-decision.worker';
import { KnowledgeSkillReviewWorker } from './application/knowledge/knowledge-skill-review.worker';
import { LarkDecisionActionWorker } from './infrastructure/channels/lark/lark-decision-action.worker';
import { createManagerTeachRoutes } from './http/desktop/manager-teach.routes';
import { createKnowledgeFileRoutes } from './http/desktop/knowledge-files.routes';
import { createWebChatRoutes } from './http/desktop/web-chat.routes';
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
  const shopifyPrivacyRepository = new PrismaShopifyPrivacyRepository(
    c.prisma,
    c.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? c.env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '',
  );
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
    decisionCardHandler:   c.decisionCardHandler,
    decisionActionQueue:    c.larkDecisionActionQueue,
    workbookConversionCardHandler: c.workbookConversionCardHandler,
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
    conversationAttachments: c.conversationAttachments,
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

    // Both WhatsApp sweeps are background work and belong under the same gate as
    // Mail Ops. The reconcile worker keeps the stream honest — replaying stuck
    // receipts and calling out a handset that went dark — and the analysis
    // worker is the one that spends money, bounded by its own quiet window and
    // cooldown rather than by this flag.
    if (c.whatsappFollowUps) {
      c.whatsappFollowUps.reconcileWorker.start();
      c.whatsappFollowUps.analysisWorker.start();
      c.logger.info('whatsapp_followups.workers_started');
    }
  } else if (c.whatsappFollowUps) {
    // Configured but not running. Said out loud, because the tab will look
    // healthy and simply never produce a follow-up.
    c.logger.warn('whatsapp_followups.workers_skipped', {
      reason: 'disabled by DIVO_AUTONOMOUS_WORKERS_ENABLED',
    });
  }

  /**
   * The broadcast poller, started whatever `DIVO_AUTONOMOUS_WORKERS_ENABLED`
   * says.
   *
   * Deliberately outside that gate, unlike the two sweeps above. Those are Divo
   * acting on its own — reading chats, spending model calls — and turning them
   * off is turning the agent off. This one is bookkeeping on work a person
   * explicitly started: the gateway has no webhook for batch progress, so
   * without something asking, a send whose author closed the tab stays marked
   * `sending` forever and its recipients stay marked `pending` for messages that
   * went out ten minutes ago.
   */
  if (c.whatsappFollowUps) {
    c.whatsappFollowUps.broadcastWorker.start();
    c.logger.info('whatsapp_broadcast.worker_started');
  }

  c.workbookConversionWorker.start();

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

  const larkDecisionActionWorker = new LarkDecisionActionWorker({
    redisUrl: c.queueRedisUrl,
    processor: c.larkDecisionActionProcessor,
    logger: c.logger,
  });
  larkDecisionActionWorker.start();

  const knowledgeSkillReviewWorker = new KnowledgeSkillReviewWorker({
    reviews: c.knowledgeSkillReviews,
    logger: c.logger,
  });
  knowledgeSkillReviewWorker.start();

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

  const cleanupConversationAttachmentAssets = () => {
    void c.conversationAttachmentAssets.cleanupExpired().catch(error => {
      c.logger.warn('conversation_attachment_asset.cleanup.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  cleanupConversationAttachmentAssets();
  const conversationAttachmentCleanupTimer = setInterval(
    cleanupConversationAttachmentAssets,
    c.env.KNOWLEDGE_FILE_CLEANUP_INTERVAL_SECONDS * 1_000,
  );
  conversationAttachmentCleanupTimer.unref?.();

  /* Readings age out on the same clock an ordinary chat attachment does. The
     recordings themselves are already gone by now — deleted the moment each one
     was read — so this only ever sweeps transcripts, screen text and the frames
     they were taken from. */
  const videoStore = c.conversationVideo;
  const pruneConversationVideo = () => {
    if (!videoStore) return;
    void videoStore
      .prune(c.env.CONVERSATION_VIDEO_RETENTION_HOURS * 3_600_000)
      .then(removed => {
        if (removed > 0) c.logger.info('conversation_video.prune.complete', { removed });
      })
      .catch(error => {
        c.logger.warn('conversation_video.prune.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  pruneConversationVideo();
  const conversationVideoPruneTimer = setInterval(
    pruneConversationVideo,
    c.env.KNOWLEDGE_FILE_CLEANUP_INTERVAL_SECONDS * 1_000,
  );
  conversationVideoPruneTimer.unref?.();

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

  // Run-trace retention (Track A): prune detailed events, step results, and
  // latency spans past the window; AiTokenUsage (cost history) is never pruned.
  const executionRepoForRetention = new ExecutionRepository(c.prisma);
  const runTraceRetention = () => {
    const cutoff = new Date(Date.now() - c.env.TRACE_RETENTION_DAYS * 86_400_000);
    void executionRepoForRetention.pruneExpiredDetail(cutoff)
      .then((pruned) => {
        if (pruned.events > 0 || pruned.steps > 0 || pruned.spans > 0) {
          c.logger.info('trace.retention.pruned', {
            events: pruned.events,
            steps:  pruned.steps,
            spans:  pruned.spans,
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

  let shopifyPrivacyRetentionRunning = false;
  const runShopifyPrivacyRetention = () => {
    if (shopifyPrivacyRetentionRunning) return;
    shopifyPrivacyRetentionRunning = true;
    void drainExpiredShopifyPrivacyRequests({ repository: shopifyPrivacyRepository })
      .then(result => {
        if (result.affected > 0 || result.hasMore) {
          c.logger.info('shopify.privacy.retention.completed', result);
        }
        if (result.hasMore) {
          c.logger.warn('shopify.privacy.retention.budget_exhausted', { affected: result.affected });
        }
      })
      .catch(error => {
        c.logger.warn('shopify.privacy.retention.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        shopifyPrivacyRetentionRunning = false;
      });
  };
  runShopifyPrivacyRetention();
  const shopifyPrivacyRetentionTimer = setInterval(runShopifyPrivacyRetention, 3_600_000);
  shopifyPrivacyRetentionTimer.unref?.();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Vary', 'Origin');
    res.header(
      'Access-Control-Allow-Headers',
      // `x-file-name` carries a recording's name on the video upload, whose body
      // is the file itself and so has no multipart envelope to put it in.
      'Authorization, Content-Type, x-api-key, x-company-id, x-file-name',
    );
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

  /* Site icons, deliberately before the authenticated mounts: an `<img>` cannot
     carry a bearer token, so this one is reached without a session. It takes a
     domain rather than a URL and cannot be aimed anywhere — see the route. */
  app.use(
    '/api/icon',
    createSiteIconRoutes({ icons: c.siteIcons, logger: c.logger }),
  );

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
      askCourier: c.connectionAskCourier,
      connectionResume: c.connectionResume,
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
      onSignInCardResolved: async ({ messageId, displayName, replaying }) => {
        const updated = await c.larkAdapter.updateMessageById(
          messageId,
          buildSignInConnectedCard({ name: displayName, replaying }),
        );
        if (!updated.ok) {
          c.logger.warn('lark.auth.sign_in_card.update_failed', {
            messageId,
            error: updated.error.message,
          });
        }
      },
    }),
  );

  // Legacy Shopify OAuth remains member-authenticated to start and HMAC/state
  // checked to finish. The admin Connected Apps UI uses per-store client
  // credentials instead, so most stores do not hit this browser callback path.
  app.use(
    '/api/shopify/auth',
    createShopifyAuthRoutes({
      authenticate: createMemberAuthMiddleware({
        prisma: c.prisma,
        jwtSecret: c.env.MEMBER_JWT_SECRET,
        logger: c.logger,
      }),
      authorization: c.shopifyAuthorizationService,
      logger: c.logger,
      frontendBaseUrl: c.env.APP_BASE_URL,
    }),
  );
  // WhatsApp's one public route. Mounted only when a gateway is configured, so
  // a deployment without OpenWA has no unauthenticated endpoint standing open.
  if (c.whatsappFollowUps) {
    app.use(
      '/api/whatsapp',
      createWhatsappWebhookRoutes({
        ingest: c.whatsappFollowUps.ingest,
        ...(c.whatsappFollowUps.webhookSecret
          ? { webhookSecret: c.whatsappFollowUps.webhookSecret }
          : {}),
        logger: c.logger,
      }),
    );
  }

  app.use(
    '/webhooks/shopify',
    createShopifyWebhookRoutes({
      ...(c.env.SHOPIFY_CLIENT_SECRET ? { clientSecret: c.env.SHOPIFY_CLIENT_SECRET } : {}),
      repository: new ShopifyWebhookRepository(
        c.prisma,
        shopifyPrivacyRepository,
      ),
      logger: c.logger,
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
      latencyRecorder: c.runLatencyRecorder,
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

  // The follow-ups tab. Member auth: a person at a keyboard, scoped to their own
  // department server-side.
  if (c.whatsappFollowUps) {
    app.use(
      '/api/follow-ups',
      memberAuth,
      createFollowUpRoutes({
        followUps: c.whatsappFollowUps.followUpsRepo,
        sessions: c.whatsappFollowUps.sessions,
        historyRepair: c.whatsappFollowUps.historyRepair,
        // The same guard the digest runner applies at delivery, applied again
        // where the room is chosen — a refusal here is one setup step, a
        // refusal there is a digest nobody ever receives.
        authorizeLarkChat: c.whatsappFollowUps.authorizeLarkChat,
        // The same resolver mail automations use. Two answers to "which
        // department is this person in" is the duplicate authority rule 5
        // forbids.
        resolveDepartmentId: c.resolveMemberDepartmentId,
        // `whatsappFollowUps`, per action group. Grant-only, so this refuses
        // every department until one is granted it — including, deliberately,
        // the department the handset is linked to.
        authorize: c.canUseFollowUps,
        auditService: c.auditService,
        logger: c.logger,
      }),
    );

    // The Broadcast tab. Same auth, the same department scope and the same
    // capability, mounted apart because it is the one WhatsApp surface that
    // writes — it is the `send` action group of one grant, not a second one.
    app.use(
      '/api/broadcasts',
      memberAuth,
      createBroadcastRoutes({
        broadcasts: c.whatsappFollowUps.broadcasts,
        resolveDepartmentId: c.resolveMemberDepartmentId,
        authorize: c.canUseFollowUps,
        auditService: c.auditService,
        logger: c.logger,
      }),
    );
  }

  // Divo answering in the browser. Member auth, not the Pi runtime lease: the
  // caller is a person at a keyboard, and the lease is minted for the container
  // this route is about to start.
  const requireChatEnabled = createRequireChatEnabled({
    chatEnabledFor: c.chatEnabledFor,
    logger: c.logger,
  });

  app.use(
    '/api/web-chat',
    memberAuth,
    requireChatEnabled,
    createWebChatRoutes({
      webRuns: c.webRuns,
      registry: c.webRunRegistry,
      threads: c.webThreads,
      logger:  c.logger,
      maxUploadBytes: c.env.KNOWLEDGE_FILE_MAX_MB * 1_024 * 1_024,
      ...(c.conversationVideo ? { videos: c.conversationVideo } : {}),
      attachmentAssets: c.conversationAttachmentAssets,
      // The same client the Lark voice-note path uses, so a recording is heard
      // identically whichever surface it was handed over on.
      ...(voiceTranscriber ? { transcriber: voiceTranscriber } : {}),
      // What Divo is waiting to hear from this person, in the thread that
      // asked rather than on a page beside it.
      decisions: c.decisions,
    }),
  );

  // Installed Desktop clients retain their client-owned confirmation route.
  // Web and Lark proceed through the governed tool path instead.
  app.use(
    '/api/desktop',
    createDesktopApprovalRoutes({
      prisma:          c.prisma,
      memberJwtSecret: c.env.MEMBER_JWT_SECRET,
      logger:          c.logger,
      decisions:       c.decisions,
    }),
  );

  // The skills a member can actually run, resolved by the same two services
  // the Pi runtime asks. Until this existed the web app had no way to answer
  // the question and showed an invented list instead.
  app.use(
    '/api/desktop',
    createDesktopSkillRoutes({
      prisma:                 c.prisma,
      memberJwtSecret:        c.env.MEMBER_JWT_SECRET,
      logger:                 c.logger,
      skillCatalog:           c.skillCatalog,
      skillAccessEnforcement: c.skillAccessEnforcement,
      permissions:            c.permissions,
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
      // The one write on this router, and deliberately the narrowest possible
      // one: it moves a poll schedule forward and touches nothing else.
      requestReconciliation: input => c.mailOpsRepo.requestReconciliation(input),
      // Creating and changing a rule run the same checks the agent's tool runs,
      // built from the same dependencies — though not, today, the same
      // function: the tool still writes through the repository directly.
      writeRule: c.writeMailRule,
      // A forward out of the company is refused by the writer and asked about
      // here, on the same card the agent path sends.
      requestExternalForwardApproval: c.requestMailRuleExternalApproval,
      // A browser session carries no run context, so the department has to be
      // looked up rather than read off the token.
      resolveDepartmentId: c.resolveMemberDepartmentId,
      canRunMailRules: c.canRunMailRules,
      // The standing summary. Same repository the worker reads it from, so the
      // schedule a member sets and the schedule the worker fires on cannot be
      // two different answers.
      briefRepo: c.mailOpsRepo,
      compileRule: c.compileMailRule,
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
      shopifyAuthorizationService: c.shopifyAuthorizationService,
      zohoTokenService:       c.zohoTokenService,
      zohoConnectionRepo:     c.zohoConnectionRepo,
      connectionRepo:         c.integrationConnectionRepo,
      mailBriefOnboarding:    c.mailBriefOnboarding,
      invalidateLarkIdentityCache: (larkOpenId: string) =>
        c.channelIdentityRepo.invalidateIdentityCache(larkOpenId),
      // Which tabs the web shell may draw for this member. Absent, the shell
      // shows everything and each route refuses for itself.
      webCapabilities:        c.webCapabilities,
      runtimeContextLifecycle: c.runtimeContextLifecycle,
      logger:                 c.logger,
      env:                    c.env,
      memberJwtSecret:        c.env.MEMBER_JWT_SECRET,
      backendPublicUrl:       c.env.BACKEND_PUBLIC_URL,
      appBaseUrl:             c.env.APP_BASE_URL,
      sessionTtlMinutes:      MEMBER_SESSION_TTL_MINUTES,
      runLatencyRecorder:     c.runLatencyRecorder,
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

  // Artifacts. One mount for both directions on purpose: the container writes
  // with a runtime lease, the browser reads with a session, and both resolve to
  // the same member — so ownership is checked once, in the repository, rather
  // than twice with a chance of disagreeing.
  //
  // Named for the resource, not for a client. A document belongs to a person,
  // and both the browser showing it and the container that wrote it are the same
  // person — so `/api/desktop/artifacts` would have named the one caller that is
  // neither of them.
  app.use(
    '/api/artifacts',
    piRuntimeMemberAuth,
    createArtifactRoutes({
      artifacts: c.artifacts,
      publishing: c.artifactPublishing,
      permissions: c.permissions,
      logger:    c.logger,
    }),
  );

  // What the signed-in member still has to do, read from their own Lark
  // account. Read-only by construction — see the module for why a dashboard
  // must not hold a credential that could finish somebody's work for them.
  app.use(
    '/api/me/tasks',
    piRuntimeMemberAuth,
    createMemberTaskRoutes({ ...c.openTasks, logger: c.logger }),
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
        latencyRecorder: c.runLatencyRecorder,
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
  /*
   * Whose mail leaves the company, and where it goes.
   *
   * Admin-guarded and separate from `/api/mail-automations` on purpose: that
   * router is pinned to the signed-in member and answers "what is Divo doing
   * for me". This one crosses every member in the company, which is a different
   * question with a different audience — and mounting it beside the personal
   * reads would have made a member-auth token enough to read everybody's
   * forwarding addresses.
   */
  app.use(
    '/api/admin/mail-governance',
    adminAuth,
    createMailGovernanceRoutes({
      readRepo: c.mailOpsReadRepo,
      logger: c.logger,
    }),
  );

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

  app.use(
    '/api/admin/shopify/privacy',
    adminAuth,
    createShopifyPrivacyRoutes({ repository: shopifyPrivacyRepository }),
  );

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
      clearInterval(shopifyPrivacyRetentionTimer);
      c.mailOpsWorker.stop();
      if (c.whatsappFollowUps) {
        c.whatsappFollowUps.reconcileWorker.stop();
        c.whatsappFollowUps.analysisWorker.stop();
        c.whatsappFollowUps.broadcastWorker.stop();
      }
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
        { name: 'workbook-conversion-worker', close: () => c.workbookConversionWorker.stop() },
        { name: 'persona-learning-worker', close: () => personaLearningWorker.stop() },
        ...(knowledgeLearningWorker
          ? [{ name: 'knowledge-learning-worker', close: () => knowledgeLearningWorker.stop() }]
          : []),
        { name: 'manager-teach-worker', close: () => managerTeachWorker.close() },
        { name: 'knowledge-review-worker', close: () => knowledgeReviewDecisionWorker.stop() },
        { name: 'lark-decision-action-worker', close: () => larkDecisionActionWorker.stop() },
        { name: 'knowledge-skill-review-worker', close: () => knowledgeSkillReviewWorker.stop() },
      ]);
      await closePhase([
        { name: 'lark-ingress-queue', close: () => c.larkIngressQueue.close() },
        { name: 'workbook-conversion-queue', close: () => c.workbookConversionQueue.close() },
        { name: 'persona-learning-queue', close: () => c.personaLearningQueue.close() },
        { name: 'knowledge-learning-queue', close: () => c.knowledgeLearningQueue.close() },
        { name: 'manager-teach-queue', close: () => c.managerTeachQueue.close() },
        { name: 'knowledge-review-queue', close: () => c.knowledgeReviewDecisionQueue.close() },
        { name: 'lark-decision-action-queue', close: () => c.larkDecisionActionQueue.close() },
        { name: 'menhood-query-pool', close: () => c.menhoodQueryService.close() },
      ]);

      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more server resources failed to stop cleanly.');
      }
    })();
    return shutdownPromise;
  };

  return app;
};
