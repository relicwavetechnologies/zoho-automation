import 'dotenv/config';
import type { TypedEnv } from './config/env';
import { RuntimeApprovalRepository } from './infrastructure/persistence/runtime-approval.repository';
import { ApprovalResolverService } from './application/approval/approval-resolver.service';
import { ApprovalGateService } from './application/approval/approval-gate.service';
import { ApprovalResumerService } from './application/approval/approval-resumer.service';
import { LarkApprovalCardHandler } from './infrastructure/channels/lark/lark-approval-card.handler';
import { ConsoleLogger } from './shared/logger';
import { createPinoLogger } from './shared/pino-logger';
import { systemClock } from './shared/clock';

// Infra
import { getPrismaClient } from './infrastructure/persistence/prisma.client';
import { getRedisClient } from './infrastructure/cache/redis.client';
import { RedisCache } from './infrastructure/cache/redis-cache';
import { CompanyRoleRepository } from './infrastructure/persistence/company-role.repository';
import { ToolPermissionRepository } from './infrastructure/persistence/tool-permission.repository';
import { ToolActionPermissionRepository } from './infrastructure/persistence/tool-action-permission.repository';
import { DepartmentRepository } from './infrastructure/persistence/department.repository';
import { DeptToolPermissionRepository } from './infrastructure/persistence/department-tool-permission.repository';
import { DeptUserOverrideRepository } from './infrastructure/persistence/department-user-override.repository';
import { ConversationRepository } from './infrastructure/persistence/conversation.repository';
import { ChannelIdentityRepository } from './infrastructure/persistence/channel-identity.repository';
import { LarkChannelAdapter } from './infrastructure/channels/lark/lark.adapter';
import { LarkPeopleResolver } from './infrastructure/channels/lark/lark-people.resolver';
import { LarkTaskClient } from './infrastructure/channels/lark/clients/lark-task.client';
import { LarkToolMessagingClient } from './infrastructure/channels/lark/clients/lark-messaging.client';
import { LarkCalendarClient } from './infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkDocClient } from './infrastructure/channels/lark/clients/lark-doc.client';
import { LarkBaseClient } from './infrastructure/channels/lark/clients/lark-base.client';
import { LarkApprovalClient } from './infrastructure/channels/lark/clients/lark-approval.client';
import { createEmbeddingService } from './infrastructure/ai/embedding/embedding.service';
import { QdrantAdapter } from './infrastructure/ai/vector/qdrant.adapter';
import { SerperClient } from './infrastructure/ai/search/serper.client';
import { WebSearchService } from './infrastructure/ai/search/web-search.service';
import { ContextSearchBroker } from './application/context-search/context-search.broker';
import { GoogleOAuthService } from './infrastructure/google/google-oauth.service';
import { GoogleUserAuthLinkRepository } from './infrastructure/google/google-user-auth-link.repository';
import { CompanyGoogleAuthLinkRepository } from './infrastructure/google/company-google-auth-link.repository';
import { GmailClient } from './infrastructure/google/google-gmail.client';
import { GoogleDriveClient } from './infrastructure/google/google-drive.client';
import { GoogleCalendarClient } from './infrastructure/google/google-calendar.client';
import { ZohoConnectionRepository } from './infrastructure/zoho/zoho-connection.repository';
import { ZohoTokenService } from './infrastructure/zoho/zoho-token.service';
import { ZohoCrmClient } from './infrastructure/zoho/zoho-crm.client';
import { ZohoBooksClient } from './infrastructure/zoho/zoho-books.client';
import { ZohoBooksPaginatedClient } from './infrastructure/zoho/zoho-books-paginated.client';
import { ZohoBooksSearchAdapter } from './infrastructure/zoho/zoho-books-search.adapter';
import { CloudinaryAdapter } from './infrastructure/cloudinary/cloudinary.adapter';
import { ZohoFinanceOps } from './application/zoho/zoho-finance-ops';
import type { CachePort } from './shared/cache';

// Observability
import { ExecutionRepository } from './infrastructure/persistence/execution.repository';
import { ExecutionQueryService } from './application/observability/execution-query.service';
import { AuditService } from './application/observability/audit.service';
import { TokenUsageService } from './application/observability/token-usage.service';
import { SkillRepository } from './infrastructure/persistence/skill.repository';
import { SkillsService } from './application/context-search/skills.service';

// Application
import { PermissionServiceImpl } from './application/permissions/permission.service';
import type { PermissionService } from './application/permissions/permission.service';
import { ChannelAdapterRegistry } from './application/channels/channel.adapter';
import { ToolRegistry } from './application/orchestration/tools/tool-registry';
import { HistoryService } from './application/orchestration/engine/history';
import { OrchestrationEngine } from './application/orchestration/engine/core';
// Multi-agent layer
import { AgentDefinitionRepository } from './infrastructure/persistence/agent-definition.repository';
import { AgentResolver } from './application/orchestration/agents/agent-resolver';
import { SupervisorAgent } from './application/orchestration/agents/supervisor';
import { SupervisorTodoRepository } from './infrastructure/persistence/supervisor-todo.repository';

// Document RAG
import { FileAssetRepository } from './infrastructure/persistence/file-asset.repository';
import { VectorDocumentRepository } from './infrastructure/persistence/vector-document.repository';
import { FileAccessPolicyRepository } from './infrastructure/persistence/file-access-policy.repository';
import { IngestionService } from './application/ingestion/ingestion.service';
import { IngestionQueue } from './application/ingestion/ingestion.queue';
import { LlmRerankerService } from './application/retrieval/llm-reranker.service';
import { DocumentRagBroker } from './application/retrieval/document-rag.broker';
import { DocumentRagTool } from './application/orchestration/tools/families/document-rag.tool';

// Knowledge Share
import { KnowledgeShareService } from './application/knowledge-share/knowledge-share.service';
import { ShareResolverService } from './application/knowledge-share/share-resolver.service';

// Tools
import { createLarkTaskTool } from './application/orchestration/tools/families/lark-task.tool';
import { createLarkMessagingTool } from './application/orchestration/tools/families/lark-messaging.tool';
import { createLarkCalendarTool } from './application/orchestration/tools/families/lark-calendar.tool';
import { createLarkDocTool } from './application/orchestration/tools/families/lark-doc.tool';
import { createLarkBaseTool } from './application/orchestration/tools/families/lark-base.tool';
import { createLarkApprovalTool } from './application/orchestration/tools/families/lark-approval.tool';
import { createGoogleGmailTool } from './application/orchestration/tools/families/google-gmail.tool';
import { createGoogleDriveTool } from './application/orchestration/tools/families/google-drive.tool';
import { createGoogleCalendarTool } from './application/orchestration/tools/families/google-calendar.tool';
import { createZohoCrmTool } from './application/orchestration/tools/families/zoho-crm.tool';
import { createZohoBooksTool } from './application/orchestration/tools/families/zoho-books.tool';
import { createContextSearchTool } from './application/orchestration/tools/families/context-search.tool';
import { createWebSearchTool } from './application/orchestration/tools/families/web-search.tool';

// AI model
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { withFallback } from './shared/model-fallback';

export interface Container {
  env: TypedEnv;
  engine: OrchestrationEngine;
  larkAdapter: LarkChannelAdapter;
  channelRegistry: ChannelAdapterRegistry;
  channelIdentityRepo: ChannelIdentityRepository;
  conversationRepo: ConversationRepository;
  logger: import('./shared/logger').Logger;
  prisma: ReturnType<typeof getPrismaClient>;
  cache: CachePort;
  // Admin surface
  permissions: PermissionService;
  toolPermRepo: ToolPermissionRepository;
  toolActionRepo: ToolActionPermissionRepository;
  deptToolPermRepo: DeptToolPermissionRepository;
  // OAuth surfaces (used by auth routes)
  googleOAuthService: GoogleOAuthService;
  googleUserLinkRepo: GoogleUserAuthLinkRepository;
  companyGoogleLinkRepo: CompanyGoogleAuthLinkRepository;
  zohoTokenService: ZohoTokenService;
  zohoConnectionRepo: ZohoConnectionRepository;
  // Observability
  executionRepo: ExecutionRepository;
  executionQueryService: ExecutionQueryService;
  auditService: AuditService;
  tokenUsageService: TokenUsageService;
  // HITL approval
  approvalGate: ApprovalGateService;
  approvalCardHandler: LarkApprovalCardHandler;
  approvalResumer: ApprovalResumerService;
  // Document RAG
  ingestionService: IngestionService;
  ingestionQueue: IngestionQueue;
  fileAssetRepo: FileAssetRepository;
  fileAccessPolicyRepo: FileAccessPolicyRepository;
  // Knowledge Share
  knowledgeShareService: KnowledgeShareService;
  shareResolverService: ShareResolverService;
}

export async function buildContainer(env: TypedEnv): Promise<Container> {
  const logger = createPinoLogger({
    isDev:   env.NODE_ENV !== 'production',
    level:   env.LOG_LEVEL,
    service: 'advance-backend',
  });

  // ── Infra ──────────────────────────────────────────────────────────────
  const prisma = getPrismaClient();
  const redis = getRedisClient(env.REDIS_URL);
  const cache = new RedisCache(redis);

  // ── Observability ──────────────────────────────────────────────────────
  const executionRepo      = new ExecutionRepository(prisma);
  const executionQueryService = new ExecutionQueryService({
    repo:   executionRepo,
    logger: logger.child({ service: 'execution-query' }),
  });
  const auditService       = new AuditService(prisma, logger.child({ service: 'audit' }));
  const tokenUsageService  = new TokenUsageService(prisma, logger.child({ service: 'token-usage' }));

  // ── Repos ──────────────────────────────────────────────────────────────
  const companyRoleRepo       = new CompanyRoleRepository(prisma);
  const toolPermRepo          = new ToolPermissionRepository(prisma);
  const toolActionRepo        = new ToolActionPermissionRepository(prisma);
  const deptRepo              = new DepartmentRepository(prisma);
  const deptToolPermRepo      = new DeptToolPermissionRepository(prisma);
  const deptUserOverrideRepo  = new DeptUserOverrideRepository(prisma);
  const conversationRepo      = new ConversationRepository(prisma);
  const channelIdentityRepo   = new ChannelIdentityRepository(prisma);

  // ── Permission service ─────────────────────────────────────────────────
  const permissions = new PermissionServiceImpl({
    companyRoleRepo,
    toolPermRepo,
    toolActionRepo,
    deptRepo,
    deptToolPermRepo,
    deptUserOverrideRepo,
    cache,
    logger: logger.child({ service: 'permissions' }),
  });

  // ── AI model (switch via MODEL_PROVIDER + MODEL_ID in .env) ─────────────
  // Primary model follows MODEL_PROVIDER + MODEL_ID.
  // Falls back silently to gpt-4o-mini on rate-limit / high-demand errors.
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  const fallbackModel = openai('gpt-4o-mini');

  const primaryModel = (() => {
    if (env.MODEL_PROVIDER === 'google') {
      const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('MODEL_PROVIDER=google but neither GOOGLE_GENERATIVE_AI_API_KEY nor GEMINI_API_KEY is set');
      const google = createGoogleGenerativeAI({ apiKey });
      return google(env.MODEL_ID);
    }
    return openai(env.MODEL_ID);
  })();

  const model = withFallback(primaryModel, fallbackModel);

  // ── Lark tool clients ──────────────────────────────────────────────────
  const larkClientDeps = { appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET };
  const larkPeopleResolver = new LarkPeopleResolver(prisma);
  const larkTaskClient     = new LarkTaskClient(larkClientDeps);
  const larkMsgToolClient  = new LarkToolMessagingClient(larkClientDeps);
  const larkCalendarClient = new LarkCalendarClient(larkClientDeps);
  const larkDocClient      = new LarkDocClient(larkClientDeps);
  const larkBaseClient     = new LarkBaseClient(larkClientDeps);
  const larkApprovalClient = new LarkApprovalClient(larkClientDeps);

  // ── AI / search infrastructure ────────────────────────────────────────────
  const embeddingService    = createEmbeddingService(env, logger.child({ service: 'embedding' }));
  const qdrantAdapter       = new QdrantAdapter({
    env,
    primaryVectorDimension: embeddingService.dimension,
    logger: logger.child({ service: 'qdrant' }),
  });
  const serperClient        = new SerperClient({
    apiKey:    env.SERPER_API_KEY ?? '',
    timeoutMs: env.SERPER_TIMEOUT_MS,
  });
  const webSearchService    = new WebSearchService(
    serperClient,
    logger.child({ service: 'web-search' }),
  );

  // ── Google OAuth + repositories ──────────────────────────────────────────
  const googleUserLinkRepo    = new GoogleUserAuthLinkRepository(prisma, env);
  const companyGoogleLinkRepo = new CompanyGoogleAuthLinkRepository(prisma, env);
  const googleOAuthService    = new GoogleOAuthService({ env, cache, logger: logger.child({ service: 'google-oauth' }) });

  /**
   * Factory: returns a typed Google client for the user, or null when not connected.
   * Resolution: user-level link → company-level link (Google Workspace admin OAuth).
   * Token is refreshed via Redis cache before being passed to the client.
   */
  async function resolveGoogleToken(companyId: string, userId: string): Promise<string | null> {
    if (!googleOAuthService.isConfigured()) return null;

    // 1. Try per-user link
    const userLink = await googleUserLinkRepo.findActiveByUser(userId, companyId);
    if (userLink.ok && userLink.value?.refreshToken) {
      try {
        return await googleOAuthService.getValidAccessToken({
          companyId, userId, refreshToken: userLink.value.refreshToken,
        });
      } catch { /* fall through to company link */ }
    }

    // 2. Fall back to company-level Workspace link (use companyId as userId key)
    const companyLink = await companyGoogleLinkRepo.findActiveByCompany(companyId);
    if (companyLink.ok && companyLink.value?.refreshToken) {
      try {
        return await googleOAuthService.getValidAccessToken({
          companyId, userId: `company:${companyId}`, refreshToken: companyLink.value.refreshToken,
        });
      } catch { /* not connected */ }
    }

    return null;
  }

  const getGmailClient = async (companyId: string, userId: string) => {
    const token = await resolveGoogleToken(companyId, userId);
    return token ? new GmailClient(token) : null;
  };

  const getDriveClient = async (companyId: string, userId: string) => {
    const token = await resolveGoogleToken(companyId, userId);
    return token ? new GoogleDriveClient(token) : null;
  };

  const getCalendarClient = async (companyId: string, userId: string) => {
    const token = await resolveGoogleToken(companyId, userId);
    return token ? new GoogleCalendarClient(token) : null;
  };

  // ── Zoho OAuth + connection ───────────────────────────────────────────────
  const zohoConnectionRepo = new ZohoConnectionRepository(prisma, env);
  const zohoTokenService   = new ZohoTokenService(
    zohoConnectionRepo,
    cache,
    env,
    logger.child({ service: 'zoho-token' }),
  );

  async function resolveZohoToken(companyId: string): Promise<string | null> {
    if (!zohoTokenService.isConfigured()) return null;
    try {
      return await zohoTokenService.getValidToken(companyId);
    } catch {
      return null;
    }
  }

  const getZohoCrmClient = async (companyId: string, _userId: string) => {
    const token = await resolveZohoToken(companyId);
    return token ? new ZohoCrmClient(token) : null;
  };

  const getZohoBooksClient = async (companyId: string, _userId: string) => {
    const token = await resolveZohoToken(companyId);
    if (!token) return null;
    // organizationId defaults to companyId in phase 1; override later when multi-org
    return new ZohoBooksClient(token, companyId);
  };

  // ── Cloudinary adapter (graceful no-op when credentials absent) ──────────
  const cloudinaryConfig = (
    env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
  ) ? {
    cloudName:  env.CLOUDINARY_CLOUD_NAME,
    apiKey:     env.CLOUDINARY_API_KEY,
    apiSecret:  env.CLOUDINARY_API_SECRET,
  } : null;

  const cloudinaryAdapter = new CloudinaryAdapter(
    cloudinaryConfig,
    cache,
    logger.child({ service: 'cloudinary' }),
  );

  // ── Document RAG repositories ─────────────────────────────────────────────
  const fileAssetRepo       = new FileAssetRepository(prisma);
  const vectorDocRepo       = new VectorDocumentRepository(prisma);
  const fileAccessPolicyRepo = new FileAccessPolicyRepository(prisma);

  const ingestionService = new IngestionService(
    env,
    cloudinaryAdapter,
    embeddingService,
    qdrantAdapter,
    fileAssetRepo,
    vectorDocRepo,
    fileAccessPolicyRepo,
    logger,
  );

  const ingestionQueue = new IngestionQueue(env.REDIS_URL, env.REDIS_INGESTION_QUEUE_NAME);

  const llmReranker = new LlmRerankerService(
    env.GROQ_API_KEY,
    logger.child({ service: 'reranker' }),
    env.RAG_GRADE_THRESHOLD,
  );

  const documentRagBroker = new DocumentRagBroker(
    env,
    qdrantAdapter,
    embeddingService,
    llmReranker,
    fileAssetRepo,
    vectorDocRepo,
    logger,
  );

  // ── Zoho Books paginated client + finance ops ────────────────────────────
  const zohoPaginatedBooksClient = new ZohoBooksPaginatedClient(zohoTokenService);

  const zohoFinanceOps = new ZohoFinanceOps(
    zohoPaginatedBooksClient,
    cloudinaryAdapter,
    logger.child({ service: 'zoho-finance-ops' }),
    env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
    env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
  );

  // ── Zoho Books search adapter (context search broker port) ───────────────
  const zohoBooksSearchAdapter = new ZohoBooksSearchAdapter(zohoPaginatedBooksClient);

  // ── Skills ────────────────────────────────────────────────────────────────
  const skillRepo    = new SkillRepository(prisma);
  const skillsService = new SkillsService({
    repo:   skillRepo,
    logger: logger.child({ service: 'skills' }),
  });

  // ── Context search broker ─────────────────────────────────────────────────
  const contextSearchBroker = new ContextSearchBroker({
    vectorStore:  qdrantAdapter,
    embedding:    embeddingService,
    webSearch:    webSearchService,
    larkContacts: channelIdentityRepo,
    zohoBooks:    zohoBooksSearchAdapter,
    skills:       skillsService,
    logger:       logger.child({ service: 'context-search' }),
  });

  // Thin adapter: WebSearchService → WebSearchClientPort (used by web-search tool)
  const webSearchClientAdapter = {
    async search(query: string, limit = 5): Promise<Array<{ title: string; url: string; snippet: string }>> {
      const result = await webSearchService.search({ query, searchResultsLimit: limit });
      return result.items.map(item => ({
        title:   item.title   ?? '',
        url:     item.link,
        snippet: item.snippet ?? '',
      }));
    },
  };

  // ── Tool registry ──────────────────────────────────────────────────────
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createLarkTaskTool({ client: larkTaskClient, peopleResolver: larkPeopleResolver }));
  toolRegistry.register(createLarkMessagingTool({ client: larkMsgToolClient }));
  toolRegistry.register(createLarkCalendarTool({ client: larkCalendarClient }));
  toolRegistry.register(createLarkDocTool({ client: larkDocClient }));
  toolRegistry.register(createLarkBaseTool({ client: larkBaseClient }));
  toolRegistry.register(createLarkApprovalTool({ client: larkApprovalClient }));
  toolRegistry.register(createGoogleGmailTool({ getClient: getGmailClient }));
  toolRegistry.register(createGoogleDriveTool({ getClient: getDriveClient }));
  toolRegistry.register(createGoogleCalendarTool({ getClient: getCalendarClient }));
  toolRegistry.register(createZohoCrmTool({ getClient: getZohoCrmClient }));
  toolRegistry.register(createZohoBooksTool({ getClient: getZohoBooksClient, financeOps: zohoFinanceOps }));
  toolRegistry.register(createContextSearchTool({ broker: contextSearchBroker }));
  toolRegistry.register(createWebSearchTool({ client: webSearchClientAdapter }));
  toolRegistry.register(new DocumentRagTool(documentRagBroker));

  logger.info('tool.registry.built', { toolCount: toolRegistry.ids().length, tools: toolRegistry.ids() });

  // ── Engine primitives ──────────────────────────────────────────────────
  const history = new HistoryService({ conversationRepo, logger: logger.child({ service: 'history' }) });

  // ── Multi-agent layer ──────────────────────────────────────────────────
  const agentDefRepo  = new AgentDefinitionRepository(prisma);
  const agentResolver = new AgentResolver(agentDefRepo, cache, logger.child({ service: 'agent-resolver' }));
  const todoRepo      = new SupervisorTodoRepository(prisma);

  const supervisor = new SupervisorAgent({
    model,
    agentResolver,
    todoRepo,
    prisma,
    logger:        logger.child({ service: 'supervisor' }),
    clock:         systemClock,
    ...((env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY) ? { geminiApiKey: (env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY) as string } : {}),
  });

  const engine = new OrchestrationEngine({
    permissions,
    toolRegistry,
    supervisor,
    history,
    executionRepo,
    logger: logger.child({ service: 'engine' }),
    clock:  systemClock,
  });

  // ── Channels ───────────────────────────────────────────────────────────
  const larkAdapter = new LarkChannelAdapter({ env, logger: logger.child({ channel: 'lark' }) });
  const channelRegistry = new ChannelAdapterRegistry();
  channelRegistry.register(larkAdapter);

  // ── HITL Approval ─────────────────────────────────────────────────────
  const approvalRepo     = new RuntimeApprovalRepository(prisma);
  const approvalResolver = new ApprovalResolverService(prisma);
  const approvalGate     = new ApprovalGateService(
    approvalRepo,
    approvalResolver,
    larkAdapter,
    logger.child({ service: 'approval-gate' }),
  );
  const approvalResumer  = new ApprovalResumerService({
    approvalRepo,
    engine,
    larkAdapter,
    channelIdentityRepo,
    conversationRepo,
    approvalGate,
    logger: logger.child({ service: 'approval-resumer' }),
  });
  const approvalCardHandler = new LarkApprovalCardHandler(
    approvalRepo,
    approvalResumer,
    larkAdapter,
    logger.child({ service: 'approval-card-handler' }),
  );

  // ── Knowledge Share ────────────────────────────────────────────────────
  const knowledgeShareService = new KnowledgeShareService(
    prisma,
    fileAssetRepo,
    fileAccessPolicyRepo,
    vectorDocRepo,
    qdrantAdapter,
    larkAdapter,
    cache,
    logger,
  );
  const shareResolverService = new ShareResolverService(
    knowledgeShareService,
    cache,
    larkAdapter,
    logger.child({ service: 'share-resolver' }),
  );

  logger.info('container.built', { channels: channelRegistry.keys() });

  return {
    env,
    engine,
    larkAdapter,
    channelRegistry,
    channelIdentityRepo,
    conversationRepo,
    logger,
    prisma,
    cache,
    permissions,
    toolPermRepo,
    toolActionRepo,
    deptToolPermRepo,
    // OAuth surfaces
    googleOAuthService,
    googleUserLinkRepo,
    companyGoogleLinkRepo,
    zohoConnectionRepo,
    zohoTokenService,
    // Observability
    executionRepo,
    executionQueryService,
    auditService,
    tokenUsageService,
    // HITL approval
    approvalGate,
    approvalCardHandler,
    approvalResumer,
    // Document RAG
    ingestionService,
    ingestionQueue,
    fileAssetRepo,
    fileAccessPolicyRepo,
    // Knowledge Share
    knowledgeShareService,
    shareResolverService,
  };
}
