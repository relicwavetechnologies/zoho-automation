import 'dotenv/config';
import type { TypedEnv } from './config/env';
import { resolveRedisUrl } from './config/env';
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
import { LarkChatContextRepository } from './infrastructure/persistence/lark-chat-context.repository';
import { LarkChatContextService } from './application/chat-context/lark-chat-context.service';
import { LarkChannelAdapter } from './infrastructure/channels/lark/lark.adapter';
import { LarkPeopleResolver } from './infrastructure/channels/lark/lark-people.resolver';
import { LarkTaskClient } from './infrastructure/channels/lark/clients/lark-task.client';
import { LarkToolMessagingClient } from './infrastructure/channels/lark/clients/lark-messaging.client';
import { LarkContactsClient } from './infrastructure/channels/lark/clients/lark-contacts.client';
import { LarkCalendarClient } from './infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkDocClient } from './infrastructure/channels/lark/clients/lark-doc.client';
import { LarkFileClient } from './infrastructure/channels/lark/clients/lark-file.client';
import { LarkBaseClient } from './infrastructure/channels/lark/clients/lark-base.client';
import { LarkApprovalClient } from './infrastructure/channels/lark/clients/lark-approval.client';
import { createEmbeddingService } from './infrastructure/ai/embedding/embedding.service';
import { QdrantAdapter } from './infrastructure/ai/vector/qdrant.adapter';
import { SerperClient } from './infrastructure/ai/search/serper.client';
import { WebSearchService } from './infrastructure/ai/search/web-search.service';
import { ContextSearchBroker } from './application/context-search/context-search.broker';
import { LarkOAuthService } from './infrastructure/lark/lark-oauth.service';
import { LarkUserAuthLinkRepository } from './infrastructure/persistence/lark-user-auth-link.repository';
import { GoogleOAuthService } from './infrastructure/google/google-oauth.service';
import { IntegrationConnectionRepository } from './infrastructure/persistence/integration-connection.repository';
import { GmailClient } from './infrastructure/google/google-gmail.client';
import { GoogleDriveClient } from './infrastructure/google/google-drive.client';
import { GoogleCalendarClient } from './infrastructure/google/google-calendar.client';
import { hasAnyGoogleScope } from './application/google/google-scope-policy';
import { ZohoConnectionRepository } from './infrastructure/zoho/zoho-connection.repository';
import { ZohoTokenService } from './infrastructure/zoho/zoho-token.service';
import { ZohoCrmClient } from './infrastructure/zoho/zoho-crm.client';
import { ZohoBooksClient } from './infrastructure/zoho/zoho-books.client';
import { ZohoBooksPaginatedClient } from './infrastructure/zoho/zoho-books-paginated.client';
import { ZohoBooksSearchAdapter } from './infrastructure/zoho/zoho-books-search.adapter';
import { ZohoCrmPaginatedClient } from './infrastructure/zoho/zoho-crm-paginated.client';
import { CloudinaryAdapter } from './infrastructure/cloudinary/cloudinary.adapter';
import { ZohoFinanceOps } from './application/zoho/zoho-finance-ops';
import { ZohoCrmOps } from './application/zoho/zoho-crm-ops';
import type { CachePort } from './shared/cache';

// Observability
import { ExecutionRepository } from './infrastructure/persistence/execution.repository';
import { ExecutionQueryService } from './application/observability/execution-query.service';
import { AuditService } from './application/observability/audit.service';
import { TokenUsageService } from './application/observability/token-usage.service';
import { SkillRepository } from './infrastructure/persistence/skill.repository';
import { SkillsService } from './application/context-search/skills.service';
import { SkillCatalogService } from './application/skills/skill-catalog.service';

// Application
import { PermissionServiceImpl } from './application/permissions/permission.service';
import type { PermissionService } from './application/permissions/permission.service';
import { ChannelAdapterRegistry } from './application/channels/channel.adapter';
import { ToolRegistry } from './application/orchestration/tools/tool-registry';
import { HistoryService } from './application/orchestration/engine/history';
import { OrchestrationEngine } from './application/orchestration/engine/core';
import { ConversationSummarizer } from './application/orchestration/engine/conversation-summarizer';
// Multi-agent layer
import { AgentDefinitionRepository } from './infrastructure/persistence/agent-definition.repository';
import { ChannelMappingRepository } from './infrastructure/persistence/channel-mapping.repository';
import { AgentAdminService } from './application/agents/agent-admin.service';
import { AgentCatalogService } from './application/agents/agent-catalog.service';
import { AgentCatalogCache } from './application/agents/agent-catalog.cache';
import { DepartmentAdminService } from './application/departments/department-admin.service';
import { DesktopDepartmentManagementService } from './application/desktop/desktop-department-management.service';
import { AgentResolver } from './application/orchestration/agents/agent-resolver';
import { ChatMessageSerializer } from './application/orchestration/chat-message-serializer';
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
import { Mem0Service } from './application/memory/mem0.service';
import { AttachmentResolverService } from './application/email/attachment-resolver.service';
import type { AttachmentSource, AttachmentSourceAdapter } from './application/email/attachment.types';
import {
  FileAssetAttachmentAdapter,
  GoogleDriveAttachmentAdapter,
  LarkAttachmentAdapter,
  OutboundArtifactAttachmentAdapter,
  CloudinaryExportAttachmentAdapter,
} from './application/email/adapters';

// Tools
import { createLarkTaskTool } from './application/orchestration/tools/families/lark-task.tool';
import { createLarkMessagingTool } from './application/orchestration/tools/families/lark-messaging.tool';
import { createLarkContactsTool } from './application/orchestration/tools/families/lark-contacts.tool';
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
import { createSkillPublishingTool } from './application/orchestration/tools/families/skill-publishing.tool';
import { createMemoryPublishingTool } from './application/orchestration/tools/families/memory-publishing.tool';
import { createMemoryRecallTool } from './application/orchestration/tools/families/memory-recall.tool';
import { createDataProcessorTool } from './application/orchestration/tools/families/data-processor.tool';
import { createRunCommandTool } from './application/orchestration/tools/families/run-command.tool';
import { ToolExecutor } from './application/gateway/tool-executor';
import { GatewayDispatcher } from './application/gateway/gateway-dispatcher';
import {
  InMemoryApprovalIntentRepository,
  LocalApprovalIntentService,
} from './application/gateway/local-approval-intent.service';
import { MediaOcrService } from './application/gateway/media-ocr.service';

// AI model
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { OAuth2Client } from 'google-auth-library';
import { withFallback } from './shared/model-fallback';
import { withGeminiSignatures, createGeminiFetch } from './shared/gemini-thought-signatures';
import { decryptToken, TokenCryptoError } from './infrastructure/shared/token.crypto';
import { redModelSelection } from './shared/model-selection-log';

type ZohoBooksOrganizationPayload = {
  organizations?: Array<{
    organization_id?: string;
    is_default?: boolean;
    is_default_org?: boolean;
  }>;
};

const GATEWAY_PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;

type GatewayProviderCacheEntry = {
  readonly apiKey: string;
  readonly gatewayBaseUrl: string;
  readonly chatModel: (modelId: string) => LanguageModel;
  readonly expiresAtMs: number;
};

export interface Container {
  env: TypedEnv;
  engine: OrchestrationEngine;
  larkAdapter: LarkChannelAdapter;
  channelRegistry: ChannelAdapterRegistry;
  channelIdentityRepo: ChannelIdentityRepository;
  conversationRepo: ConversationRepository;
  logger: import('./shared/logger').Logger;
  prisma: ReturnType<typeof getPrismaClient>;
  /** Hot-path app cache: permissions, OAuth tokens, agent defs. → REDIS_CACHE_URL */
  cache: CachePort;
  /** Memory system + short-lived keys: nonces, knowledge-share, Cloudinary. → REDIS_MEMORY_URL */
  memoryCache: CachePort;
  /** Resolved Redis URL for the BullMQ queue — exposed so workers can share the same URL. */
  queueRedisUrl: string;
  /** LLM model for lightweight tasks (summaries, classification). */
  model: import('ai').LanguageModel;
  /** Per-chat message serializer — one engine.run() at a time per chatId. */
  chatSerializer: ChatMessageSerializer;
  /** Scheduled workflow executor — polls for due tasks every N ms. */
  scheduledWorkflowService: import('./application/scheduling/scheduled-workflow.service').ScheduledWorkflowService;
  // Admin surface
  permissions: PermissionService;
  toolPermRepo: ToolPermissionRepository;
  companyRoleRepo: CompanyRoleRepository;
  toolActionRepo: ToolActionPermissionRepository;
  deptToolPermRepo: DeptToolPermissionRepository;
  deptUserOverrideRepo: DeptUserOverrideRepository;
  toolRegistry: ToolRegistry;
  skillCatalog: SkillCatalogService;
  // Agent admin CRUD
  agentAdminService:      AgentAdminService;
  agentCatalogCache:      AgentCatalogCache;
  departmentAdminService: DepartmentAdminService;
  desktopDepartmentManagementService: DesktopDepartmentManagementService;
  // Lark user OAuth
  larkOAuthService:     LarkOAuthService;
  larkUserAuthLinkRepo: LarkUserAuthLinkRepository;
  // OAuth surfaces (used by auth routes)
  googleOAuthService: GoogleOAuthService;
  integrationConnectionRepo: IntegrationConnectionRepository;
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
  cloudinaryAdapter: CloudinaryAdapter;
  fileAssetRepo: FileAssetRepository;
  fileAccessPolicyRepo: FileAccessPolicyRepository;
  // Knowledge Share
  knowledgeShareService: KnowledgeShareService;
  shareResolverService: ShareResolverService;
  // Persistent memory
  mem0Service: Mem0Service | null;
  invalidateGatewayProviderCache: (companyId: string) => void;
  // Group chat context
  chatContextService: LarkChatContextService;
  // Lark contacts (for directory sync)
  larkContactsClient: LarkContactsClient;
  // Pi/Desktop capability gateway
  gatewayDispatcher: GatewayDispatcher;
}

export async function buildContainer(env: TypedEnv): Promise<Container> {
  const logger = createPinoLogger({
    isDev:   env.NODE_ENV !== 'production',
    level:   env.LOG_LEVEL,
    service: 'advance-backend',
  });

  // ── Infra ──────────────────────────────────────────────────────────────
  const prisma = getPrismaClient();

  // Three purposeful Redis connections. Each falls back to REDIS_URL in local
  // dev so a single Redis instance continues to work with no config changes.
  //   queueRedisUrl  → BullMQ only (blocking cmds, Lua scripts, pub/sub)
  //   cacheRedisUrl  → hot-path app cache (permissions, tokens, agent defs)
  //   memoryRedisUrl → memory system + nonces + knowledge-share + Cloudinary
  const queueRedisUrl  = resolveRedisUrl(env.REDIS_QUEUE_URL,  env.REDIS_URL);
  const cacheRedisUrl  = resolveRedisUrl(env.REDIS_CACHE_URL,  env.REDIS_URL);
  const memoryRedisUrl = resolveRedisUrl(env.REDIS_MEMORY_URL, env.REDIS_URL);

  const cache       = new RedisCache(getRedisClient(cacheRedisUrl));
  const memoryCache = new RedisCache(getRedisClient(memoryRedisUrl));

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
  const conversationRepo      = new ConversationRepository(prisma, cache);
  const channelIdentityRepo   = new ChannelIdentityRepository(prisma, cache);
  const larkChatContextRepo   = new LarkChatContextRepository(prisma);

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

  // ── AI model (DB config first, env fallback) ────────────────────────────
  // Primary model follows AiModelTargetConfig(targetKey='default') when present,
  // then falls back to MODEL_PROVIDER + MODEL_ID for backward compatibility.
  // Falls back silently to configured fast model, or gpt-4o-mini (direct OpenAI) by default,
  // on rate-limit / high-demand errors.
  const defaultModelTarget = await prisma.aiModelTargetConfig.findUnique({
    where: { targetKey: 'default' },
  });

  const createConfiguredModel = (provider: string, modelId: string) => {
    if (provider === 'google') {
      const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('AI provider google selected but neither GOOGLE_GENERATIVE_AI_API_KEY nor GEMINI_API_KEY is set');
      // Layer 1: custom fetch fixes sig attribution in raw API responses
      // before @ai-sdk/google parses them. Layer 2 (withGeminiSignatures)
      // is defence-in-depth for the outgoing prompt direction.
      const google = createGoogleGenerativeAI({ apiKey, fetch: createGeminiFetch() });
      return withGeminiSignatures(google(modelId));
    }
    if (provider === 'openai') {
      return openaiModel(modelId);
    }
    if (provider === 'deepseek') {
      // The SDK resolves a missing key when a DeepSeek request is made. Keep
      // startup independent from this optional provider (the proxy can also
      // receive a company or platform key after the server is running).
      const ds = createDeepSeek(env.DEEPSEEK_API_KEY ? { apiKey: env.DEEPSEEK_API_KEY } : {});
      return ds(modelId);
    }
    throw new Error(`Unsupported AI model provider: ${provider}`);
  };

  const primaryProvider = defaultModelTarget?.provider ?? env.MODEL_PROVIDER;
  const primaryModelId  = defaultModelTarget?.modelId ?? env.MODEL_ID;
  const fastProvider    = defaultModelTarget?.fastProvider ?? 'openai';
  const fastModelId     = defaultModelTarget?.fastModelId ?? 'gpt-4o-mini';
  const needsOpenAi     = primaryProvider === 'openai' || fastProvider === 'openai';
  const gatewayCompany  = needsOpenAi
    ? await prisma.company.findFirst({
      where:   { gatewayApiKey: { not: null } },
      select:  { id: true, gatewayApiKey: true, gatewayUrl: true },
      orderBy: { updatedAt: 'desc' },
    })
    : null;
  const configuredGatewayBaseUrl = env.GATEWAY_BASE_URL.trim().replace(/\/+$/, '');
  const gatewayBaseUrl = (configuredGatewayBaseUrl || gatewayCompany?.gatewayUrl || '').trim().replace(/\/+$/, '');
  const gatewayOpenAi = (() => {
    if (!gatewayCompany?.gatewayApiKey || !gatewayBaseUrl) return null;
    try {
      const apiKey = decryptToken(gatewayCompany.gatewayApiKey, env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '');
      logger.info('ai.openai.gateway.enabled', { companyId: gatewayCompany.id, gatewayBaseUrl });
      return createOpenAI({ apiKey, baseURL: `${gatewayBaseUrl}/v1` });
    } catch (error) {
      if (error instanceof TokenCryptoError) {
        logger.warn('ai.openai.gateway.decrypt_failed', { companyId: gatewayCompany.id, error: error.message });
        return null;
      }
      throw error;
    }
  })();
  const directOpenAi    = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  const openaiModel     = (modelId: string) => gatewayOpenAi ? gatewayOpenAi.chat(modelId) : directOpenAi(modelId);
  const directOpenAiModel = (modelId: string) => directOpenAi(modelId);
  const gatewayProviderCache = new Map<string, GatewayProviderCacheEntry>();
  const invalidateGatewayProviderCache = (companyId: string) => {
    const deleted = gatewayProviderCache.delete(companyId);
    logger.info('ai.openai.gateway.agent_model.cache_invalidated', { companyId, deleted });
  };
  const primaryModel    = createConfiguredModel(primaryProvider, primaryModelId);
  const fallbackModel   = fastProvider === 'openai'
    ? directOpenAiModel(fastModelId)
    : createConfiguredModel(fastProvider, fastModelId);
  const model = withFallback(primaryModel, fallbackModel);

  const chatContextService = new LarkChatContextService({
    repo: larkChatContextRepo,
    model: fallbackModel,
    logger: logger.child({ service: 'chat-context' }),
  });
  logger.warn('ai.model.selected', {
    provider: primaryProvider,
    modelId: primaryModelId,
    source: 'company_default_startup',
    selection: redModelSelection({
      provider: primaryProvider,
      modelId: primaryModelId,
      source: 'company_default_startup',
    }),
  });
  logger.warn('ai.model.selected', {
    provider: fastProvider,
    modelId: fastModelId,
    source: 'fallback_startup',
    selection: redModelSelection({
      provider: fastProvider,
      modelId: fastModelId,
      source: 'fallback_startup',
    }),
  });
  const resolveModel = async (input: {
    provider: string;
    modelId: string;
    companyId: string;
    agentSlug?: string;
  }): Promise<LanguageModel> => {
    if (input.provider === 'google' || input.provider === 'deepseek') {
      return createConfiguredModel(input.provider, input.modelId);
    }
    if (input.provider !== 'openai') {
      throw new Error(`Unsupported AI model provider: ${input.provider}`);
    }

    const nowMs = Date.now();
    const cached = gatewayProviderCache.get(input.companyId);
    if (cached && cached.expiresAtMs > nowMs) {
      logger.info('ai.openai.gateway.agent_model.cache_hit', {
        companyId: input.companyId,
        agentSlug: input.agentSlug,
        gatewayBaseUrl: cached.gatewayBaseUrl,
      });
      return cached.chatModel(input.modelId);
    }
    if (cached) {
      gatewayProviderCache.delete(input.companyId);
    }

    logger.info('ai.openai.gateway.agent_model.cache_miss', {
      companyId: input.companyId,
      agentSlug: input.agentSlug,
    });

    const company = await prisma.company.findUnique({
      where:  { id: input.companyId },
      select: { id: true, gatewayApiKey: true, gatewayUrl: true },
    });
    const companyGatewayBaseUrl = (configuredGatewayBaseUrl || company?.gatewayUrl || '').trim().replace(/\/+$/, '');
    if (company?.gatewayApiKey && companyGatewayBaseUrl) {
      try {
        const apiKey = decryptToken(company.gatewayApiKey, env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '');
        logger.info('ai.openai.gateway.agent_model.enabled', {
          companyId: input.companyId,
          agentSlug: input.agentSlug,
          gatewayBaseUrl: companyGatewayBaseUrl,
        });
        const gatewayProvider = createOpenAI({ apiKey, baseURL: `${companyGatewayBaseUrl}/v1` });
        gatewayProviderCache.set(input.companyId, {
          apiKey,
          gatewayBaseUrl: companyGatewayBaseUrl,
          chatModel: (modelId: string) => gatewayProvider.chat(modelId),
          expiresAtMs: nowMs + GATEWAY_PROVIDER_CACHE_TTL_MS,
        });
        return gatewayProvider.chat(input.modelId);
      } catch (error) {
        if (error instanceof TokenCryptoError) {
          gatewayProviderCache.delete(input.companyId);
          logger.warn('ai.openai.gateway.agent_model.decrypt_failed', {
            companyId: input.companyId,
            agentSlug: input.agentSlug,
            error: error.message,
          });
        } else {
          throw error;
        }
      }
    }

    return directOpenAi(input.modelId);
  };

  // ── Lark tool clients ──────────────────────────────────────────────────
  const larkClientDeps = { appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET };
  const larkPeopleResolver = new LarkPeopleResolver(prisma);
  const larkTaskClient     = new LarkTaskClient(larkClientDeps);
  const larkMsgToolClient  = new LarkToolMessagingClient(larkClientDeps);
  const larkContactsClient = new LarkContactsClient(larkClientDeps);
  const larkCalendarClient = new LarkCalendarClient(larkClientDeps);
  const larkDocClient      = new LarkDocClient(larkClientDeps);
  const larkFileClient     = new LarkFileClient(env, logger);
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

  // ── Lark user OAuth ───────────────────────────────────────────────────────
  const larkOAuthService = new LarkOAuthService(
    env.LARK_APP_ID,
    env.LARK_APP_SECRET,
    env.LARK_OAUTH_REDIRECT_URI ?? `${env.BACKEND_PUBLIC_URL}/api/lark/auth/callback`,
    env.LARK_API_BASE_URL,
  );
  const larkUserAuthLinkRepo = new LarkUserAuthLinkRepository(
    prisma,
    env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '',
  );

  // ── Google OAuth + connection registry ───────────────────────────────────
  const integrationConnectionRepo = new IntegrationConnectionRepository(prisma, env);
  const googleOAuthService        = new GoogleOAuthService({ env, cache, logger: logger.child({ service: 'google-oauth' }) });

  async function resolveGoogleAuthClient(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopes?: readonly string[];
  }): Promise<OAuth2Client | null> {
    if (!googleOAuthService.isConfigured()) return null;

    const connection = await integrationConnectionRepo.findAccessibleGoogleConnection(input);
    if (!connection.ok || !connection.value?.refreshToken) return null;
    if (!hasAnyGoogleScope(connection.value.scopes, input.requiredScopes ?? [])) {
      logger.warn('google.connection.missing_required_scope', {
        companyId: input.companyId,
        userId: input.userId,
        connectionId: input.connectionId,
        requiredScopes: input.requiredScopes ?? [],
      });
      return null;
    }

    try {
      const token = await googleOAuthService.getValidAccessToken({
        companyId:    input.companyId,
        userId:       `connection:${input.connectionId}`,
        refreshToken: connection.value.refreshToken,
      });
      await integrationConnectionRepo.touchLastUsed(input.connectionId);
      const auth = googleOAuthService.createOAuth2Client({
        refreshToken: connection.value.refreshToken,
        accessToken:  token,
      });
      auth.on('tokens', (tokens) => {
        const accessTokenExpiresAt = typeof tokens.expiry_date === 'number'
          ? new Date(tokens.expiry_date)
          : undefined;
        void integrationConnectionRepo.updateGoogleTokens({
          companyId:    input.companyId,
          connectionId: input.connectionId,
          ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(tokens.token_type ? { tokenType: tokens.token_type } : {}),
          ...(tokens.scope ? { scope: tokens.scope } : {}),
          ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
        });
      });
      return auth;
    } catch {
      return null;
    }
  }

  const getGmailClient = async (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopes: readonly string[];
  }) => {
    const auth = await resolveGoogleAuthClient(input);
    return auth ? new GmailClient(auth) : null;
  };

  const getDriveClient = async (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopes: readonly string[];
  }) => {
    const auth = await resolveGoogleAuthClient(input);
    return auth ? new GoogleDriveClient(auth) : null;
  };

  const getCalendarClient = async (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopes: readonly string[];
  }) => {
    const auth = await resolveGoogleAuthClient(input);
    return auth ? new GoogleCalendarClient(auth) : null;
  };

  // ── Zoho OAuth + connection ───────────────────────────────────────────────
  const zohoConnectionRepo = new ZohoConnectionRepository(prisma, env);
  const zohoTokenService   = new ZohoTokenService(
    zohoConnectionRepo,
    cache,
    env,
    logger.child({ service: 'zoho-token' }),
    integrationConnectionRepo,
  );

  async function resolveZohoAuth(
    companyId: string,
    userId?: string,
    connectionId?: string,
    minimumAccess: 'read_only' | 'read_write' = 'read_only',
  ): Promise<{ accessToken: string; apiBaseUrl: string } | null> {
    if (!zohoTokenService.isConfigured()) {
      logger.warn('zoho.token.not_configured', { companyId });
      return null;
    }
    try {
      const auth = connectionId && userId
        ? await zohoTokenService.getValidConnectionAuth({ companyId, userId, connectionId, minimumAccess })
        : {
          accessToken: await zohoTokenService.getValidToken(companyId),
          apiBaseUrl: env.ZOHO_API_BASE_URL.replace(/\/$/, ''),
        };
      logger.info('zoho.token.resolved', { companyId, connectionId, hasToken: !!auth.accessToken });
      return auth;
    } catch (e) {
      logger.error('zoho.token.resolve_failed', { companyId, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  const zohoBooksOrgCache = new Map<string, { organizationId: string; expiresAtMs: number }>();

  async function resolveZohoBooksOrganizationId(
    companyId: string,
    token: string,
    apiBaseUrl: string,
    connectionId?: string,
  ): Promise<string | null> {
    const cacheKey = connectionId ?? companyId;
    const cached = zohoBooksOrgCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.organizationId;
    }

    try {
      const apiRoot = apiBaseUrl.replace(/\/$/, '');
      const res = await fetch(`${apiRoot}/books/v3/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });

      const payload = (await res.json().catch(() => ({}))) as ZohoBooksOrganizationPayload & {
        code?: number;
        message?: string;
      };

      if (!res.ok) {
        logger.warn('zoho.books.organization_lookup.failed', {
          companyId,
          status: res.status,
          code: payload.code,
          message: payload.message,
        });
        return null;
      }

      const orgs = Array.isArray(payload.organizations) ? payload.organizations : [];
      const selected = orgs.find((org) => org.is_default_org === true || org.is_default === true) ?? orgs[0];
      const organizationId = selected?.organization_id;
      if (!organizationId) {
        logger.warn('zoho.books.organization_lookup.empty', { companyId });
        return null;
      }

      zohoBooksOrgCache.set(cacheKey, {
        organizationId,
        expiresAtMs: Date.now() + 10 * 60 * 1000,
      });
      return organizationId;
    } catch (error) {
      logger.warn('zoho.books.organization_lookup.error', {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  const getZohoCrmClient = async (companyId: string, userId: string, connectionId?: string) => {
    const auth = await resolveZohoAuth(companyId, userId, connectionId);
    return auth ? new ZohoCrmClient(auth.accessToken, auth.apiBaseUrl) : null;
  };

  const getZohoBooksClient = async (
    companyId: string,
    userId: string,
    connectionId?: string,
    minimumAccess: 'read_only' | 'read_write' = 'read_only',
  ) => {
    const auth = await resolveZohoAuth(companyId, userId, connectionId, minimumAccess);
    if (!auth) return null;
    const organizationId = await resolveZohoBooksOrganizationId(
      companyId,
      auth.accessToken,
      auth.apiBaseUrl,
      connectionId,
    );
    return organizationId
      ? new ZohoBooksClient(auth.accessToken, organizationId, auth.apiBaseUrl)
      : null;
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
    memoryCache,
    logger.child({ service: 'cloudinary' }),
  );

  // ── Document RAG repositories ─────────────────────────────────────────────
  const fileAssetRepo       = new FileAssetRepository(prisma);
  const vectorDocRepo       = new VectorDocumentRepository(prisma);
  const fileAccessPolicyRepo = new FileAccessPolicyRepository(prisma);
  const attachmentAdapters = new Map<AttachmentSource, AttachmentSourceAdapter>([
    ['file_asset', new FileAssetAttachmentAdapter(fileAssetRepo, cloudinaryAdapter)],
    ['outbound_artifact', new OutboundArtifactAttachmentAdapter(prisma)],
    ['google_drive', new GoogleDriveAttachmentAdapter(getDriveClient)],
    ['lark', new LarkAttachmentAdapter(larkFileClient)],
    ['cloudinary', new CloudinaryExportAttachmentAdapter(cloudinaryAdapter)],
  ]);
  const attachmentResolver = new AttachmentResolverService(attachmentAdapters);

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

  const ingestionQueue = new IngestionQueue(queueRedisUrl, env.REDIS_INGESTION_QUEUE_NAME);

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
  const zohoPaginatedBooksClient = new ZohoBooksPaginatedClient(zohoTokenService, env.ZOHO_API_BASE_URL);

  const zohoFinanceOps = new ZohoFinanceOps(
    zohoPaginatedBooksClient,
    cloudinaryAdapter,
    logger.child({ service: 'zoho-finance-ops' }),
    env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
    env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
  );

  // ── Zoho CRM paginated client + CRM ops ──────────────────────────────────
  const zohoPaginatedCrmClient = new ZohoCrmPaginatedClient(zohoTokenService, env.ZOHO_API_BASE_URL);

  const zohoCrmOps = new ZohoCrmOps(
    zohoPaginatedCrmClient,
    cloudinaryAdapter,
    logger.child({ service: 'zoho-crm-ops' }),
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
  const skillCatalog = new SkillCatalogService({
    repo: skillRepo,
    logger,
  });

  // ── Context search broker ─────────────────────────────────────────────────
  const contextSearchBroker = new ContextSearchBroker({
    vectorStore:    qdrantAdapter,
    embedding:      embeddingService,
    webSearch:      webSearchService,
    larkContacts:   channelIdentityRepo,
    zohoBooks:      zohoBooksSearchAdapter,
    skills:         skillsService,
    logger:         logger.child({ service: 'context-search' }),
    fileAssetRepo,
    vectorDocRepo,
    ...(env.GROQ_API_KEY ? { groqApiKey: env.GROQ_API_KEY } : {}),
    ...((env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY)
      ? { geminiApiKey: (env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY) as string }
      : {}),
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

  logger.info('mem0.config', {
    MEM0_ENABLED: env.MEM0_ENABLED,
    MEM0_EXTRACTION_MODEL: env.MEM0_EXTRACTION_MODEL,
    MEM0_QDRANT_COLLECTION: env.MEM0_QDRANT_COLLECTION,
    QDRANT_URL: env.QDRANT_URL,
    hasQdrantApiKey: !!env.QDRANT_API_KEY,
    qdrantApiKeyLength: env.QDRANT_API_KEY?.length ?? 0,
  });

  const mem0Service = env.MEM0_ENABLED
    ? new Mem0Service({
      openaiApiKey:    env.OPENAI_API_KEY,
      qdrantUrl:       env.QDRANT_URL,
      ...(env.QDRANT_API_KEY ? { qdrantApiKey: env.QDRANT_API_KEY } : {}),
      collectionName:  env.MEM0_QDRANT_COLLECTION,
      extractionModel: env.MEM0_EXTRACTION_MODEL,
      maxResults:      env.MEM0_MAX_RESULTS,
      logger:          logger.child({ service: 'mem0' }),
    })
    : null;

  logger.info('mem0.status', { enabled: !!mem0Service });

  // ── Tool registry ──────────────────────────────────────────────────────
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createLarkTaskTool({
    client: larkTaskClient,
    peopleResolver: larkPeopleResolver,
    userTokenResolver: {
      async resolve(userId: string, companyId: string): Promise<string | null> {
        const link = await larkUserAuthLinkRepo.findByUserId(userId, companyId);
        if (!link.ok || !link.value) return null;
        const { accessToken, refreshToken, accessTokenExpiresAt } = link.value;
        const isExpired = accessTokenExpiresAt && new Date(accessTokenExpiresAt).getTime() < Date.now() + 60_000;
        if (!isExpired && accessToken) return accessToken;
        if (!refreshToken) return null;
        try {
          const refreshed = await larkOAuthService.refreshUserToken(refreshToken);
          await larkUserAuthLinkRepo.upsert({
            userId, companyId,
            larkOpenId:    link.value.larkOpenId ?? '',
            larkTenantKey: link.value.larkTenantKey,
            larkEmail:     link.value.larkEmail,
            accessToken:   refreshed.accessToken,
            refreshToken:  refreshed.refreshToken ?? refreshToken,
            tokenType:     refreshed.tokenType,
            accessTokenExpiresAt:  new Date(Date.now() + refreshed.expiresIn * 1000),
            refreshTokenExpiresAt: refreshed.refreshTokenExpiresIn
              ? new Date(Date.now() + refreshed.refreshTokenExpiresIn * 1000)
              : null,
          });
          return refreshed.accessToken;
        } catch {
          return null;
        }
      },
    },
    createUserClient: (userToken: string) =>
      new LarkTaskClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, userToken }),
  }));
  toolRegistry.register(createLarkMessagingTool({ client: larkMsgToolClient, peopleResolver: larkPeopleResolver }));
  toolRegistry.register(createLarkContactsTool({ peopleResolver: larkPeopleResolver, contactsClient: larkContactsClient }));
  toolRegistry.register(createLarkCalendarTool({ client: larkCalendarClient, peopleResolver: larkPeopleResolver }));
  toolRegistry.register(createLarkDocTool({ client: larkDocClient }));
  toolRegistry.register(createLarkBaseTool({ client: larkBaseClient }));
  toolRegistry.register(createLarkApprovalTool({ client: larkApprovalClient }));
  toolRegistry.register(createGoogleGmailTool({
    getClient: getGmailClient,
    resolveAttachments: (refs, ctx) => attachmentResolver.resolve(refs, ctx),
  }));
  toolRegistry.register(createGoogleDriveTool({ getClient: getDriveClient }));
  toolRegistry.register(createGoogleCalendarTool({ getClient: getCalendarClient }));
  toolRegistry.register(createZohoCrmTool({
    getClient:   getZohoCrmClient,
    crmClient:   zohoPaginatedCrmClient,
    crmOps:      zohoCrmOps,
    cloudinary:  cloudinaryAdapter,
    csvLinkTtl:  env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
  }));
  toolRegistry.register(createZohoBooksTool({
    getClient:       getZohoBooksClient,
    booksClient:     zohoPaginatedBooksClient,
    financeOps:      zohoFinanceOps,
    cloudinary:      cloudinaryAdapter,
    inlineThreshold: env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
    csvLinkTtl:      env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
  }));
  toolRegistry.register(createContextSearchTool({ broker: contextSearchBroker }));
  toolRegistry.register(createWebSearchTool({ client: webSearchClientAdapter }));
  toolRegistry.register(createSkillPublishingTool({ prisma }));
  toolRegistry.register(createMemoryPublishingTool({ mem0: mem0Service }));
  toolRegistry.register(createMemoryRecallTool({ mem0: mem0Service, departmentRepo: deptRepo }));
  toolRegistry.register(new DocumentRagTool(documentRagBroker));
  toolRegistry.register(createDataProcessorTool({
    cloudinary:  cloudinaryAdapter,
    booksClient: zohoPaginatedBooksClient,
    csvLinkTtl:  env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
  }));
  toolRegistry.register(createRunCommandTool());

  logger.info('tool.registry.built', { toolCount: toolRegistry.ids().length, tools: toolRegistry.ids() });

  // ── Skill registry (unified agent mode) ───────────────────────────────
  const { createDefaultSkillRegistry } = await import('./application/skills');
  const skillRegistry = createDefaultSkillRegistry();

  // ── Engine primitives ──────────────────────────────────────────────────
  const history = new HistoryService({ conversationRepo, logger: logger.child({ service: 'history' }) });

  // ── Multi-agent layer ──────────────────────────────────────────────────
  const agentDefRepo       = new AgentDefinitionRepository(prisma);
  const channelMappingRepo = new ChannelMappingRepository(prisma);
  const agentResolver = new AgentResolver(agentDefRepo, cache, logger.child({ service: 'agent-resolver' }));
  const agentCatalogService = new AgentCatalogService(agentDefRepo, logger.child({ service: 'agent-catalog' }));
  const agentCatalogCache = new AgentCatalogCache(agentCatalogService, logger.child({ service: 'agent-catalog-cache' }));
  const agentAdminService  = new AgentAdminService({
    agentDefRepo,
    channelMappingRepo,
    prisma,
    logger: logger.child({ service: 'agent-admin' }),
    invalidateAgentCache: async (companyId: string) => {
      await agentResolver.invalidate(companyId);
      agentCatalogCache.invalidate(companyId);
    },
  });
  const departmentAdminService = new DepartmentAdminService({
    prisma,
    logger: logger.child({ service: 'department-admin' }),
    permissions,
  });
  const desktopDepartmentManagementService = new DesktopDepartmentManagementService({
    prisma,
    departmentAdminService,
    auditService,
    logger: logger.child({ service: 'desktop-department-management' }),
  });
  const todoRepo      = new SupervisorTodoRepository(prisma);

  const supervisor = new SupervisorAgent({
    model,
    defaultModel: { provider: primaryProvider, modelId: primaryModelId },
    resolveModel,
    agentResolver,
    agentCatalogCache,
    todoRepo,
    prisma,
    logger:        logger.child({ service: 'supervisor' }),
    clock:         systemClock,
    dynamicGraphEnabled: env.DYNAMIC_GRAPH_ENABLED,
    supervisorTimeoutMs: env.SUPERVISOR_TIMEOUT_MS,
    unifiedAgentMode: env.UNIFIED_AGENT_MODE,
    skillRegistry,
    toolRegistry,
    ...(mem0Service ? { mem0: mem0Service } : {}),
    ...((env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY) ? { geminiApiKey: (env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY) as string } : {}),
  });

  // Per-chat serializer: ensures only one engine.run() runs per chatId at a time.
  // Timeout must exceed the worst-case supervisor run (660s for dynamic graph with
  // agent retry). Using 720s (12 min) to add buffer. The AbortSignal is threaded
  // to the engine so timed-out runs are actually cancelled, not just abandoned.
  // maxConcurrent caps total parallel engine runs to prevent resource exhaustion.
  const chatSerializer = new ChatMessageSerializer({
    timeoutMs: 720_000,
    maxConcurrent: 10,
    onTimeout: (chatId) => {
      logger.warn('chat_serializer.timeout', { chatId });
    },
  });

  const conversationSummarizer = new ConversationSummarizer({
    conversationRepo,
    model,
    cache,
    logger: logger.child({ service: 'conversation-summarizer' }),
  });

  const engine = new OrchestrationEngine({
    permissions,
    toolRegistry,
    supervisor,
    history,
    executionRepo,
    ...(mem0Service ? { mem0: mem0Service } : {}),
    fastPathModel: model,
    chatContext: chatContextService,
    conversationSummarizer,
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
  const disableManagerSelfBypass = env.NODE_ENV !== 'production' && env.DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS;
  if (disableManagerSelfBypass) {
    logger.warn('approval.gate.manager_self_bypass_disabled_for_test');
  }
  const approvalGate     = new ApprovalGateService(
    approvalRepo,
    approvalResolver,
    larkAdapter,
    logger.child({ service: 'approval-gate' }),
    { disableManagerSelfBypass },
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

  const gatewayToolExecutor = new ToolExecutor({
    toolRegistry,
    permissions,
    approvalGate,
    logger: logger.child({ service: 'gateway-tool-executor' }),
    clock:  systemClock,
  });
  const localApprovalIntents = new LocalApprovalIntentService({
    toolExecutor: gatewayToolExecutor,
    repository: new InMemoryApprovalIntentRepository(),
    clock: systemClock,
    logger: logger.child({ service: 'gateway-local-approval' }),
  });
  const mediaOcr = new MediaOcrService(env, logger);
  const gatewayDispatcher = new GatewayDispatcher({
    permissions,
    toolRegistry,
    skillCatalog,
    toolExecutor: gatewayToolExecutor,
    localApprovalIntents,
    connectionRegistry: integrationConnectionRepo,
    mediaOcr,
    logger: logger.child({ service: 'gateway-dispatcher' }),
  });

  // ── Knowledge Share ────────────────────────────────────────────────────
  const knowledgeShareService = new KnowledgeShareService(
    prisma,
    fileAssetRepo,
    fileAccessPolicyRepo,
    vectorDocRepo,
    qdrantAdapter,
    larkAdapter,
    memoryCache,
    logger,
  );
  const shareResolverService = new ShareResolverService(
    knowledgeShareService,
    memoryCache,
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
    memoryCache,
    queueRedisUrl,
    permissions,
    toolPermRepo,
    companyRoleRepo,
    toolActionRepo,
    deptToolPermRepo,
    deptUserOverrideRepo,
    toolRegistry,
    skillCatalog,
    // Agent admin CRUD
    agentAdminService,
    agentCatalogCache,
    departmentAdminService,
    desktopDepartmentManagementService,
    // Lark user OAuth
    larkOAuthService,
    larkUserAuthLinkRepo,
    // OAuth surfaces
    googleOAuthService,
    integrationConnectionRepo,
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
    cloudinaryAdapter,
    fileAssetRepo,
    fileAccessPolicyRepo,
    // Knowledge Share
    knowledgeShareService,
    shareResolverService,
    mem0Service,
    invalidateGatewayProviderCache,
    // Message serialization
    chatSerializer,
    // Group chat context
    chatContextService,
    // Lark contacts (for directory sync)
    larkContactsClient,
    // Pi/Desktop capability gateway
    gatewayDispatcher,
    // LLM model
    model,
    // Scheduled workflow executor
    scheduledWorkflowService: new (await import('./application/scheduling/scheduled-workflow.service')).ScheduledWorkflowService({
      prisma,
      engine,
      channelAdapter: larkAdapter,
      channelIdentityRepo,
      logger: logger.child({ service: 'scheduled-workflow' }),
      clock:  systemClock,
      pollIntervalMs: env.SCHEDULED_WORKFLOW_POLL_INTERVAL_MS,
    }),
  };
}
