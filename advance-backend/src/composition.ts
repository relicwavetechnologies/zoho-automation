import 'dotenv/config';
import { resolve } from 'node:path';
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
import type { LarkUserTokenResolution } from './application/orchestration/tools/families/lark-user-connection';
import { LarkToolMessagingClient } from './infrastructure/channels/lark/clients/lark-messaging.client';
import { LarkContactsClient } from './infrastructure/channels/lark/clients/lark-contacts.client';
import { LarkCalendarClient } from './infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkMeetingClient } from './infrastructure/channels/lark/clients/lark-meeting.client';
import { LarkDocClient } from './infrastructure/channels/lark/clients/lark-doc.client';
import { LarkBaseClient } from './infrastructure/channels/lark/clients/lark-base.client';
import { LarkApprovalClient } from './infrastructure/channels/lark/clients/lark-approval.client';
import { createEmbeddingService } from './infrastructure/ai/embedding/embedding.service';
import { QdrantAdapter } from './infrastructure/ai/vector/qdrant.adapter';
import { SerperClient } from './infrastructure/ai/search/serper.client';
import { WebSearchService } from './infrastructure/ai/search/web-search.service';
import { ContextSearchBroker } from './application/context-search/context-search.broker';
import { LarkOAuthService } from './infrastructure/lark/lark-oauth.service';
import { GoogleOAuthService } from './infrastructure/google/google-oauth.service';
import { GoogleWorkspaceMcpClient } from './infrastructure/google/google-workspace-mcp.client';
import { GoogleWorkspaceMcpSchemaCatalog } from './infrastructure/google/google-workspace-mcp-schema.catalog';
import { GoogleWorkspaceGatewayClient } from './infrastructure/google/google-workspace-gateway.client';
import { CanvaMcpOAuthService } from './infrastructure/canva/canva-mcp-oauth.service';
import { CanvaMcpClient } from './infrastructure/canva/canva-mcp.client';
import { IntegrationConnectionRepository } from './infrastructure/persistence/integration-connection.repository';
import {
  publicConnectionChoices,
  selectAccessibleConnection,
} from './application/connections/accessible-connection-selection';
import { CompanySerperConnectionRepository } from './infrastructure/persistence/company-serper-connection.repository';
import { CompanySerperService } from './application/web-search/company-serper.service';
import { hasGoogleScopeGroups } from './domain/google/google-workspace-scope';
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
import { ProxyKeyStore } from './application/proxy/proxy-key.store';
import { LlmProxyService } from './application/proxy/llm-proxy.service';
import { LarkInferenceService } from './application/proxy/lark-inference.service';
import { SkillRepository } from './infrastructure/persistence/skill.repository';
import { SkillAccessRepository } from './infrastructure/persistence/skill-access.repository';
import { SkillsService } from './application/context-search/skills.service';
import { SkillCatalogService } from './application/skills/skill-catalog.service';
import { SkillRegistryAdminService } from './application/skills/skill-registry-admin.service';

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
import { PersonaLearningQueue } from './application/persona-learning/persona-learning.queue';
import { DeepSeekPersonaLearningExtractor } from './application/persona-learning/persona-learning.extractor';
import { PersonaLearningService } from './application/persona-learning/persona-learning.service';
import { PersonaLearningPromotionService } from './application/persona-learning/persona-learning-promotion.service';
import { ManagerPersonaRuntimeService } from './application/persona-learning/manager-persona-runtime.service';
import { ManagerPersonaRevisionService } from './application/persona-learning/manager-persona-revision.service';
import { ManagerTeachQueue } from './application/persona-learning/manager-teach.queue';
import { ManagerTeachService } from './application/persona-learning/manager-teach.service';
import { ManagerTeachMediaProcessor } from './application/persona-learning/manager-teach-media.processor';
import { PeepshowManagerTeachExtractor } from './infrastructure/media/peepshow-manager-teach.extractor';
import { OpenRouterManagerTeachFrameOcr } from './infrastructure/ai/ocr/openrouter-manager-teach.ocr';
import { OpenAiManagerTeachTranscriber } from './infrastructure/ai/transcription/openai-manager-teach.transcriber';
import { LlmRerankerService } from './application/retrieval/llm-reranker.service';
import { DocumentRagBroker } from './application/retrieval/document-rag.broker';
import { DocumentRagTool } from './application/orchestration/tools/families/document-rag.tool';

// Knowledge Share
import { KnowledgeShareService } from './application/knowledge-share/knowledge-share.service';
import { ShareResolverService } from './application/knowledge-share/share-resolver.service';
import { Mem0Service } from './application/memory/mem0.service';

// Tools
import { createLarkTaskTool } from './application/orchestration/tools/families/lark-task.tool';
import { createLarkMessagingTool } from './application/orchestration/tools/families/lark-messaging.tool';
import { createLarkContactsTool } from './application/orchestration/tools/families/lark-contacts.tool';
import { createLarkCalendarTool } from './application/orchestration/tools/families/lark-calendar.tool';
import { createLarkMeetingTool } from './application/orchestration/tools/families/lark-meeting.tool';
import { createLarkDocTool } from './application/orchestration/tools/families/lark-doc.tool';
import { createLarkBaseTool } from './application/orchestration/tools/families/lark-base.tool';
import { createLarkApprovalTool } from './application/orchestration/tools/families/lark-approval.tool';
import { createGoogleWorkspaceMcpTools } from './application/orchestration/tools/families/google-workspace-mcp.tool';
import { createCanvaDesignTool } from './application/orchestration/tools/families/canva-design.tool';
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
  skillRegistryAdminService: SkillRegistryAdminService;
  // Agent admin CRUD
  agentAdminService:      AgentAdminService;
  agentCatalogCache:      AgentCatalogCache;
  departmentAdminService: DepartmentAdminService;
  desktopDepartmentManagementService: DesktopDepartmentManagementService;
  // Lark user OAuth
  larkOAuthService: LarkOAuthService;
  // OAuth surfaces (used by auth routes)
  googleOAuthService: GoogleOAuthService;
  canvaMcpOAuthService: CanvaMcpOAuthService;
  integrationConnectionRepo: IntegrationConnectionRepository;
  companySerperConnectionRepo: CompanySerperConnectionRepository;
  companySerperService: CompanySerperService;
  zohoTokenService: ZohoTokenService;
  zohoConnectionRepo: ZohoConnectionRepository;
  // Observability
  executionRepo: ExecutionRepository;
  executionQueryService: ExecutionQueryService;
  auditService: AuditService;
  tokenUsageService: TokenUsageService;
  proxyKeyStore: ProxyKeyStore;
  llmProxyService: LlmProxyService;
  // HITL approval
  approvalGate: ApprovalGateService;
  approvalCardHandler: LarkApprovalCardHandler;
  approvalResumer: ApprovalResumerService;
  // Document RAG
  ingestionService: IngestionService;
  ingestionQueue: IngestionQueue;
  // Manager learning P1–P4. Promotion remains isolated from memory, skills, and RBAC.
  personaLearningQueue: PersonaLearningQueue;
  personaLearningService: PersonaLearningService;
  personaLearningPromotionService: PersonaLearningPromotionService;
  managerPersonaRuntimeService: ManagerPersonaRuntimeService;
  managerPersonaRevisionService: ManagerPersonaRevisionService;
  managerTeachQueue: ManagerTeachQueue;
  managerTeachService: ManagerTeachService;
  managerTeachUploadDir: string;
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
  const proxyKeyStore = new ProxyKeyStore({
    prisma,
    logger,
    encryptionKey: env.PROXY_KEY_ENCRYPTION_KEY ?? env.ZOHO_TOKEN_ENCRYPTION_KEY,
    envFallbackKey: env.DEEPSEEK_API_KEY,
  });
  const llmProxyService = new LlmProxyService(prisma, logger.child({ service: 'llm-proxy-policy' }));
  const larkInferenceService = new LarkInferenceService({
    store: proxyKeyStore,
    policy: llmProxyService,
    logger,
    baseUrl: env.DEEPSEEK_BASE_URL,
  });

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
  const larkClientDeps = {
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    apiBaseUrl: env.LARK_API_BASE_URL,
  };
  const larkPeopleResolver = new LarkPeopleResolver(prisma);
  const larkTaskClient     = new LarkTaskClient(larkClientDeps);
  const larkMsgToolClient  = new LarkToolMessagingClient(larkClientDeps);
  const larkContactsClient = new LarkContactsClient(larkClientDeps);
  const larkCalendarClient = new LarkCalendarClient(larkClientDeps);
  const larkMeetingClient  = new LarkMeetingClient(larkClientDeps);
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
  const serperEncryptionKey = env.SERPER_CONNECTION_ENCRYPTION_KEY ?? env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
  const companySerperConnectionRepo = new CompanySerperConnectionRepository(prisma, serperEncryptionKey);
  const companySerperService = new CompanySerperService(
    companySerperConnectionRepo,
    memoryCache,
    env.SERPER_TIMEOUT_MS,
    logger.child({ service: 'company-serper' }),
    env.SERPER_API_KEY ?? '',
  );

  // ── Lark user OAuth ───────────────────────────────────────────────────────
  const larkOAuthService = new LarkOAuthService(
    env.LARK_APP_ID,
    env.LARK_APP_SECRET,
    env.LARK_OAUTH_REDIRECT_URI ?? `${env.BACKEND_PUBLIC_URL}/api/lark/auth/callback`,
    env.LARK_API_BASE_URL,
  );

  // ── Google OAuth + connection registry ───────────────────────────────────
  const integrationConnectionRepo = new IntegrationConnectionRepository(prisma, env);
  const googleOAuthService        = new GoogleOAuthService({ env, cache, logger: logger.child({ service: 'google-oauth' }) });
  const googleWorkspaceMcpSchemas = new GoogleWorkspaceMcpSchemaCatalog();
  const canvaMcpOAuthService      = new CanvaMcpOAuthService({ env, cache: memoryCache, logger });

  async function getGoogleWorkspaceMcpConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId?: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopeGroups: readonly (readonly string[])[];
  }) {
    if (!googleOAuthService.isConfigured()) return { status: 'unavailable' as const };

    const accessible = await integrationConnectionRepo.listAccessibleGoogleConnections({
      companyId: input.companyId,
      userId: input.userId,
    });
    if (!accessible.ok) return { status: 'unavailable' as const };
    const scopeEligible = accessible.value.filter((connection) =>
      hasGoogleScopeGroups(connection.scopes, input.requiredScopeGroups),
    );
    const selection = selectAccessibleConnection({
      connections: scopeEligible,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      minimumAccess: input.minimumAccess,
    });
    if (selection.status === 'choose_connection') {
      return {
        status: 'choose_connection' as const,
        connections: publicConnectionChoices(selection.connections),
      };
    }
    if (selection.status === 'unavailable') {
      const requested = input.connectionId
        ? accessible.value.find((connection) => connection.connectionId === input.connectionId)
        : undefined;
      if (requested && !hasGoogleScopeGroups(requested.scopes, input.requiredScopeGroups)) {
        logger.warn('google.connection.missing_required_scope', {
          companyId: input.companyId,
          userId: input.userId,
          connectionId: input.connectionId,
          requiredScopeGroups: input.requiredScopeGroups,
        });
      }
      return { status: 'unavailable' as const };
    }

    const selectedConnectionId = selection.connection.connectionId;
    const connection = await integrationConnectionRepo.findAccessibleGoogleConnection({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: selectedConnectionId,
      minimumAccess: input.minimumAccess,
    });
    if (!connection.ok || !connection.value?.refreshToken) {
      return { status: 'unavailable' as const };
    }
    if (!hasGoogleScopeGroups(connection.value.scopes, input.requiredScopeGroups)) {
      logger.warn('google.connection.missing_required_scope', {
        companyId: input.companyId,
        userId: input.userId,
        connectionId: selectedConnectionId,
        requiredScopeGroups: input.requiredScopeGroups,
      });
      return { status: 'unavailable' as const };
    }

    try {
      const token = await googleOAuthService.getValidAccessToken({
        companyId:    input.companyId,
        userId:       `connection:${selectedConnectionId}`,
        refreshToken: connection.value.refreshToken,
      });
      await integrationConnectionRepo.touchLastUsed(selectedConnectionId);
      return {
        status: 'resolved' as const,
        connection: {
          client: new GoogleWorkspaceGatewayClient(
            token,
            new GoogleWorkspaceMcpClient(
              token,
              env.GOOGLE_WORKSPACE_MCP_URL,
              googleWorkspaceMcpSchemas,
            ),
          ),
        },
      };
    } catch (error) {
      logger.warn('google.connection.token_resolution_failed', {
        companyId: input.companyId,
        userId: input.userId,
        connectionId: selectedConnectionId,
        error: String(error),
      });
      return { status: 'unavailable' as const };
    }
  }

  async function getCanvaMcpClient(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: 'read_only' | 'read_write';
  }): Promise<CanvaMcpClient | null> {
    if (!canvaMcpOAuthService.isConfigured()) return null;
    const connection = await integrationConnectionRepo.findAccessibleCanvaConnection(input);
    if (!connection.ok || !connection.value?.accessToken) return null;
    let accessToken = connection.value.accessToken;
    const expiresSoon = connection.value.accessTokenExpiresAt
      ? connection.value.accessTokenExpiresAt.getTime() <= Date.now() + 60_000
      : false;
    if (expiresSoon && connection.value.refreshToken) {
      try {
        const metadata = connection.value.tokenMetadata ?? {};
        const refreshed = await canvaMcpOAuthService.refreshConnectionTokens({
          accessToken,
          refreshToken: connection.value.refreshToken,
          ...(connection.value.tokenType ? { tokenType: connection.value.tokenType } : {}),
          scopes: connection.value.scopes,
          ...(metadata['oauthClientInformation'] ? { clientInformation: metadata['oauthClientInformation'] as any } : {}),
          ...(metadata['oauthDiscoveryState'] ? { discoveryState: metadata['oauthDiscoveryState'] as any } : {}),
        });
        accessToken = refreshed.accessToken;
        await integrationConnectionRepo.updateCanvaTokens({
          companyId: input.companyId,
          connectionId: input.connectionId,
          accessToken: refreshed.accessToken,
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          tokenType: refreshed.tokenType,
          ...(refreshed.expiresIn ? { accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000) } : {}),
          scopes: refreshed.scopes,
          tokenMetadata: {
            ...(refreshed.clientInformation ? { oauthClientInformation: refreshed.clientInformation } : {}),
            ...(refreshed.discoveryState ? { oauthDiscoveryState: refreshed.discoveryState } : {}),
          },
        });
      } catch (error) {
        logger.warn('canva.connection.refresh_failed', {
          companyId: input.companyId,
          userId: input.userId,
          connectionId: input.connectionId,
          error: String(error),
        });
        return null;
      }
    }
    await integrationConnectionRepo.touchLastUsed(input.connectionId);
    return new CanvaMcpClient(accessToken, env.CANVA_MCP_URL);
  }

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
  const personaLearningQueue = new PersonaLearningQueue(
    queueRedisUrl,
    env.REDIS_PERSONA_LEARNING_QUEUE_NAME,
  );
  const personaLearningService = new PersonaLearningService({
    prisma,
    queue: personaLearningQueue,
    extractor: new DeepSeekPersonaLearningExtractor(
      createConfiguredModel('deepseek', env.PERSONA_LEARNING_MODEL_ID),
      env.PERSONA_LEARNING_MODEL_ID,
    ),
    logger,
  });
  const personaLearningPromotionService = new PersonaLearningPromotionService({ prisma, logger });
  const managerPersonaRuntimeService = new ManagerPersonaRuntimeService({ prisma, logger });
  const managerPersonaRevisionService = new ManagerPersonaRevisionService({ prisma, logger });
  const managerTeachQueue = new ManagerTeachQueue(queueRedisUrl, env.REDIS_MANAGER_TEACH_QUEUE_NAME);
  const managerTeachUploadDir = resolve(env.MANAGER_TEACH_UPLOAD_DIR);
  const managerTeachMediaProcessor = new ManagerTeachMediaProcessor({
    extractor: new PeepshowManagerTeachExtractor({
      maxFrames: env.MANAGER_TEACH_MAX_FRAMES,
      width: env.MANAGER_TEACH_FRAME_WIDTH,
      sceneThreshold: env.MANAGER_TEACH_SCENE_THRESHOLD,
      timeoutMs: env.MANAGER_TEACH_MEDIA_TIMEOUT_SECONDS * 1_000,
    }),
    ocr: new OpenRouterManagerTeachFrameOcr({
      apiKey: env.OPENROUTER_API_KEY ?? '',
      model: env.MANAGER_TEACH_OCR_MODEL,
    }),
    transcriber: new OpenAiManagerTeachTranscriber({
      apiKey: env.OPENAI_API_KEY,
      model: env.MANAGER_TEACH_TRANSCRIPTION_MODEL,
      chunkSeconds: env.MANAGER_TEACH_TRANSCRIPTION_CHUNK_SECONDS,
    }),
    logger,
    ocrConcurrency: env.MANAGER_TEACH_OCR_CONCURRENCY,
    transcriptionModel: env.MANAGER_TEACH_TRANSCRIPTION_MODEL,
  });
  const managerTeachService = new ManagerTeachService({
    prisma,
    queue: managerTeachQueue,
    logger,
    mediaProcessor: managerTeachMediaProcessor,
    maxVideoBytes: env.MANAGER_TEACH_MAX_VIDEO_MB * 1_024 * 1_024,
    rawRetentionHours: env.MANAGER_TEACH_RAW_RETENTION_HOURS,
  });

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
  const skillAccessEnforcement = new SkillAccessRepository(prisma);
  const skillRegistryAdminService = new SkillRegistryAdminService({
    prisma,
    logger: logger.child({ service: 'skill-registry-admin' }),
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
    async search(companyId: string, query: string, limit = 5): Promise<Array<{ title: string; url: string; snippet: string }>> {
      const result = await companySerperService.search(companyId, { query, num: limit });
      return result.organic.map(item => ({ title: item.title ?? '', url: item.link ?? '', snippet: item.snippet ?? '' })).filter(item => item.url);
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
  const larkUserTokenResolver = {
      async resolve(input: {
        userId: string;
        companyId: string;
        connectionId?: string;
        minimumAccess: 'read_only' | 'read_write';
      }): Promise<LarkUserTokenResolution> {
        const accessible = await integrationConnectionRepo.listAccessibleLarkConnections({
          userId: input.userId,
          companyId: input.companyId,
        });
        if (!accessible.ok) return { status: 'unavailable' as const };
        const selection = selectAccessibleConnection({
          connections: accessible.value,
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          minimumAccess: input.minimumAccess,
        });
        if (selection.status === 'choose_connection') {
          return {
            status: 'choose_connection' as const,
            connections: publicConnectionChoices(selection.connections),
          };
        }
        if (selection.status === 'unavailable') return { status: 'unavailable' as const };
        const connection = await integrationConnectionRepo.findAccessibleLarkConnection({
          companyId: input.companyId,
          userId: input.userId,
          connectionId: selection.connection.connectionId,
          minimumAccess: input.minimumAccess,
        });
        if (!connection.ok || !connection.value?.accessToken) return { status: 'unavailable' as const };
        const { accessToken, refreshToken, accessTokenExpiresAt } = connection.value;
        const expiresSoon = accessTokenExpiresAt?.getTime() ?? 0;
        if (expiresSoon > Date.now() + 60_000) {
          await integrationConnectionRepo.touchLastUsed(connection.value.id);
          return { status: 'resolved' as const, accessToken };
        }
        if (!refreshToken) return { status: 'unavailable' as const };
        try {
          const refreshed = await larkOAuthService.refreshUserToken(refreshToken);
          const persisted = await integrationConnectionRepo.updateLarkTokens({
            connectionId: connection.value.id,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? refreshToken,
            tokenType: refreshed.tokenType,
            accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
            refreshTokenExpiresAt: refreshed.refreshTokenExpiresIn
              ? new Date(Date.now() + refreshed.refreshTokenExpiresIn * 1000)
              : null,
          });
          return persisted.ok
            ? { status: 'resolved' as const, accessToken: refreshed.accessToken }
            : { status: 'unavailable' as const };
        } catch {
          return { status: 'unavailable' as const };
        }
      },
  };
  toolRegistry.register(createLarkTaskTool({
    client: larkTaskClient,
    peopleResolver: larkPeopleResolver,
    userTokenResolver: larkUserTokenResolver,
    createUserClient: (userToken: string) =>
      new LarkTaskClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, apiBaseUrl: env.LARK_API_BASE_URL, userToken }),
  }));
  toolRegistry.register(createLarkMessagingTool({
    client: larkMsgToolClient,
    peopleResolver: larkPeopleResolver,
    userTokenResolver: larkUserTokenResolver,
    createUserClient: (userToken: string) =>
      new LarkToolMessagingClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, apiBaseUrl: env.LARK_API_BASE_URL, userToken }),
  }));
  toolRegistry.register(createLarkContactsTool({
    peopleResolver: larkPeopleResolver,
    contactsClient: larkContactsClient,
  }));
  toolRegistry.register(createLarkCalendarTool({
    client: larkCalendarClient,
    peopleResolver: larkPeopleResolver,
    userTokenResolver: larkUserTokenResolver,
    createUserClient: (userToken: string) =>
      new LarkCalendarClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, apiBaseUrl: env.LARK_API_BASE_URL, userToken }),
  }));
  toolRegistry.register(createLarkMeetingTool({
    client: larkMeetingClient,
    userTokenResolver: larkUserTokenResolver,
    createUserClient: (userToken: string) =>
      new LarkMeetingClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, apiBaseUrl: env.LARK_API_BASE_URL, userToken }),
  }));
  toolRegistry.register(createLarkDocTool({
    client: larkDocClient,
    userTokenResolver: larkUserTokenResolver,
    createUserClient: (userToken: string) =>
      new LarkDocClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, apiBaseUrl: env.LARK_API_BASE_URL, userToken }),
  }));
  toolRegistry.register(createLarkBaseTool({
    client: larkBaseClient,
    userTokenResolver: larkUserTokenResolver,
    createUserClient: (userToken: string) =>
      new LarkBaseClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET, apiBaseUrl: env.LARK_API_BASE_URL, userToken }),
  }));
  toolRegistry.register(createLarkApprovalTool({
    client: larkApprovalClient,
  }));
  for (const tool of createGoogleWorkspaceMcpTools({ getConnection: getGoogleWorkspaceMcpConnection })) {
    toolRegistry.register(tool);
  }
  toolRegistry.register(createCanvaDesignTool({ getClient: getCanvaMcpClient }));
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
    permissions,
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
    skillCatalog,
    skillAccessEnforcement,
    auditService,
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
    larkInference: larkInferenceService,
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
    managerPersonaRuntime: managerPersonaRuntimeService,
    skillAccessEnforcement,
    auditService,
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
    skillRegistryAdminService,
    // Agent admin CRUD
    agentAdminService,
    agentCatalogCache,
    departmentAdminService,
    desktopDepartmentManagementService,
    // Lark user OAuth
    larkOAuthService,
    // OAuth surfaces
    googleOAuthService,
    canvaMcpOAuthService,
    integrationConnectionRepo,
    companySerperConnectionRepo,
    companySerperService,
    zohoConnectionRepo,
    zohoTokenService,
    // Observability
    executionRepo,
    executionQueryService,
    auditService,
    tokenUsageService,
    proxyKeyStore,
    llmProxyService,
    // HITL approval
    approvalGate,
    approvalCardHandler,
    approvalResumer,
    // Document RAG
    ingestionService,
    ingestionQueue,
    personaLearningQueue,
    personaLearningService,
    personaLearningPromotionService,
    managerPersonaRuntimeService,
    managerPersonaRevisionService,
    managerTeachQueue,
    managerTeachService,
    managerTeachUploadDir,
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
