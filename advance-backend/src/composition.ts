import 'dotenv/config';
import { resolve } from 'node:path';
import type { TypedEnv } from './config/env';
import {
  getGmailPubSubConfig,
  resolveRedisUrl,
} from './config/env';
import { RuntimeApprovalRepository } from './infrastructure/persistence/runtime-approval.repository';
import { ApprovalInboxService } from './application/approval/approval-inbox.service';
import { buildApprovalResolutionCard } from './application/approval/approval-card-builder';
import { ApprovalResolverService } from './application/approval/approval-resolver.service';
import { ApprovalGateService } from './application/approval/approval-gate.service';
import { ApprovalResumerService } from './application/approval/approval-resumer.service';
import { AutomationPlanService } from './application/gateway/automation-plan.service';
import { AutomationPlanExecutor } from './application/gateway/automation-plan.executor';
import { LarkApprovalCardHandler } from './infrastructure/channels/lark/lark-approval-card.handler';
import { ConsoleLogger } from './shared/logger';
import { createPinoLogger } from './shared/pino-logger';
import { systemClock } from './shared/clock';

// Infra
import { getPrismaClient } from './infrastructure/persistence/prisma.client';
import { getRedisClient } from './infrastructure/cache/redis.client';
import { RedisCache } from './infrastructure/cache/redis-cache';
import { RedisRateLimitStore } from './infrastructure/governance/redis-rate-limit.store';
import { PrismaConnectionGovernanceRepository } from './infrastructure/persistence/connection-governance.repository';
import { CompanyRoleRepository } from './infrastructure/persistence/company-role.repository';
import { ToolPermissionRepository } from './infrastructure/persistence/tool-permission.repository';
import { ToolActionPermissionRepository } from './infrastructure/persistence/tool-action-permission.repository';
import { DepartmentRepository } from './infrastructure/persistence/department.repository';
import { DeptToolPermissionRepository } from './infrastructure/persistence/department-tool-permission.repository';
import { DeptUserOverrideRepository } from './infrastructure/persistence/department-user-override.repository';
import { ConversationRepository } from './infrastructure/persistence/conversation.repository';
import { ChannelIdentityRepository } from './infrastructure/persistence/channel-identity.repository';
import { LarkChatContextRepository } from './infrastructure/persistence/lark-chat-context.repository';
import { IngressReceiptRepository } from './infrastructure/persistence/ingress-receipt.repository';
import { LarkChatContextService } from './application/chat-context/lark-chat-context.service';
import { GroupContextHydrator } from './application/chat-context/group-context.hydrator';
import { LarkChannelAdapter } from './infrastructure/channels/lark/lark.adapter';
import { LarkPeopleResolver } from './infrastructure/channels/lark/lark-people.resolver';
import { LarkTaskClient } from './infrastructure/channels/lark/clients/lark-task.client';
import type { LarkUserTokenResolution } from './application/tools/families/lark-user-connection';
import { LarkToolMessagingClient } from './infrastructure/channels/lark/clients/lark-messaging.client';
import { LarkContactsClient } from './infrastructure/channels/lark/clients/lark-contacts.client';
import { LarkCalendarClient } from './infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkMeetingClient } from './infrastructure/channels/lark/clients/lark-meeting.client';
import { LarkDocClient } from './infrastructure/channels/lark/clients/lark-doc.client';
import { LarkBaseClient } from './infrastructure/channels/lark/clients/lark-base.client';
import { LarkApprovalClient } from './infrastructure/channels/lark/clients/lark-approval.client';
import { SerperClient } from './infrastructure/ai/search/serper.client';
import { LarkOAuthService } from './infrastructure/lark/lark-oauth.service';
import { GoogleOAuthService } from './infrastructure/google/google-oauth.service';
import { GoogleWorkspaceMcpClient } from './infrastructure/google/google-workspace-mcp.client';
import { GoogleWorkspaceMcpSchemaCatalog } from './infrastructure/google/google-workspace-mcp-schema.catalog';
import { GoogleWorkspaceGatewayClient } from './infrastructure/google/google-workspace-gateway.client';
import { CanvaMcpOAuthService } from './infrastructure/canva/canva-mcp-oauth.service';
import { CanvaMcpClient } from './infrastructure/canva/canva-mcp.client';
import { AirtableMcpOAuthService } from './infrastructure/airtable/airtable-mcp-oauth.service';
import { AirtableMcpClient } from './infrastructure/airtable/airtable-mcp.client';
import { AirtableMcpSchemaCatalog } from './infrastructure/airtable/airtable-mcp-schema.catalog';
import { AitableClient } from './infrastructure/aitable/aitable.client';
import { createAitableKeyVerifier, type AitableKeyVerifier } from './application/aitable/aitable-connect.service';
import { selectAitableConnection } from './application/aitable/aitable-connection-selection';
import { IntegrationConnectionRepository } from './infrastructure/persistence/integration-connection.repository';
import { ConnectionAuthorizationRepository } from './infrastructure/persistence/connection-authorization.repository';
import { ChannelDeliveryRepository } from './infrastructure/persistence/channel-delivery.repository';
import { ExecutionLaneLeaseRepository } from './infrastructure/persistence/execution-lane-lease.repository';
import { LaneLeaseHolder } from './application/channels/lane-lease.holder';
import { BusyLaneNotices } from './infrastructure/channels/lark/lark-busy-notice';
import { randomUUID } from 'node:crypto';
import {
  publicConnectionChoices,
  selectAccessibleConnection,
} from './application/connections/accessible-connection-selection';
import { CompanySerperConnectionRepository } from './infrastructure/persistence/company-serper-connection.repository';
import { CompanySerperService } from './application/web-search/company-serper.service';
import { SemrushClient } from './infrastructure/semrush/semrush.client';
import { SemrushService } from './application/semrush/semrush.service';
import { CompanyOmsConnectionRepository } from './infrastructure/persistence/company-oms-connection.repository';
import { OmsSiteDataClient } from './infrastructure/oms/oms-site-data.client';
import { CompanyOmsSiteDataService } from './application/oms/company-oms-site-data.service';
import { GOOGLE_SCOPE, hasGoogleScopeGroups } from './domain/google/google-workspace-scope';
import { asCompanyRoleSlug } from './domain/permissions/company-role';
import {
  asCompanyId,
  asDepartmentId,
  asToolId,
  asUserId,
} from './shared/ids';
import { ZohoConnectionRepository } from './infrastructure/zoho/zoho-connection.repository';
import { ZohoTokenService } from './infrastructure/zoho/zoho-token.service';
import { ZohoCrmClient } from './infrastructure/zoho/zoho-crm.client';
import { ZohoBooksClient } from './infrastructure/zoho/zoho-books.client';
import { ZohoBooksPaginatedClient } from './infrastructure/zoho/zoho-books-paginated.client';
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
import { SkillCatalogService } from './application/skills/skill-catalog.service';
import { SkillRegistryAdminService } from './application/skills/skill-registry-admin.service';

// Application
import { PermissionServiceImpl } from './application/permissions/permission.service';
import type { PermissionService } from './application/permissions/permission.service';
import { ChannelAdapterRegistry } from './application/channels/channel.adapter';
import { ToolRegistry } from './application/tools/tool-registry';
// Multi-agent layer
import { DepartmentAdminService } from './application/departments/department-admin.service';
import { DesktopDepartmentManagementService } from './application/desktop/desktop-department-management.service';
import { ChatMessageSerializer } from './application/channels/chat-message-serializer';

// Document RAG
import { DataExportQueue } from './application/data-export/data-export.queue';
import { DataExportSourceRegistry } from './application/data-export/data-export.types';
import {
  AirtableDataExportSource,
  ZohoBooksDataExportSource,
} from './application/data-export/data-export.sources';
import { GoogleWorkspaceExportSink } from './application/data-export/google-workspace-export.sink';
import { parseDataExportProfile, DATA_EXPORT_CAPABILITY_ID } from './application/data-export/data-export.profile';
import { LarkIngressQueue } from './application/lark-ingress/lark-ingress.queue';
import {
  GoogleConnectionContinuationQueue,
} from './application/connections/google-connection-continuation';
import {
  GoogleConnectionAuthorizationService,
} from './application/connections/google-connection-authorization.service';
import { MailOpsWorker } from './application/mail-ops/mail-ops.worker';
import { GmailHistoryClient } from './infrastructure/google/gmail-history.client';
import { MailOpsRepository } from './infrastructure/persistence/mail-ops.repository';
import {
  buildGoogleConnectCard,
  googleConnectFallbackText,
} from './infrastructure/channels/lark/lark-google-connect';
import { PersonaLearningQueue } from './application/persona-learning/persona-learning.queue';
import { DeepSeekPersonaLearningExtractor } from './application/persona-learning/persona-learning.extractor';
import { PersonaLearningService } from './application/persona-learning/persona-learning.service';
import { PersonaLearningPromotionService } from './application/persona-learning/persona-learning-promotion.service';
import { ManagerPersonaRuntimeService } from './application/persona-learning/manager-persona-runtime.service';
import { ManagerPersonaRevisionService } from './application/persona-learning/manager-persona-revision.service';
import { ManagerTeachQueue } from './application/persona-learning/manager-teach.queue';
import { ManagerTeachService } from './application/persona-learning/manager-teach.service';
import { ManagerTeachMediaProcessor } from './application/persona-learning/manager-teach-media.processor';
import { ManagerTeachPersonaProcessor } from './application/persona-learning/manager-teach-persona.processor';
import { PeepshowManagerTeachExtractor } from './infrastructure/media/peepshow-manager-teach.extractor';
import { OpenRouterManagerTeachFrameOcr } from './infrastructure/ai/ocr/openrouter-manager-teach.ocr';
import { OpenAiManagerTeachTranscriber } from './infrastructure/ai/transcription/openai-manager-teach.transcriber';

// Knowledge Share
import { Mem0Service } from './application/memory/mem0.service';
import { LarkMemoryReviewService } from './application/memory/lark-memory-review.service';

// Tools
import { createLarkTaskTool } from './application/tools/families/lark-task.tool';
import { createLarkMessagingTool } from './application/tools/families/lark-messaging.tool';
import { createLarkContactsTool } from './application/tools/families/lark-contacts.tool';
import { createLarkCalendarTool } from './application/tools/families/lark-calendar.tool';
import { createLarkMeetingTool } from './application/tools/families/lark-meeting.tool';
import { createLarkDocTool } from './application/tools/families/lark-doc.tool';
import { createLarkBaseTool } from './application/tools/families/lark-base.tool';
import { createLarkApprovalTool } from './application/tools/families/lark-approval.tool';
import { createGoogleWorkspaceMcpTools } from './application/tools/families/google-workspace-mcp.tool';
import { createCanvaDesignTool } from './application/tools/families/canva-design.tool';
import {
  createAirtableMcpTools,
  type ResolveAirtableMcpConnection,
} from './application/tools/families/airtable-mcp.tool';
import { createAitableTools } from './application/tools/families/aitable.tool';
import { hasAirtableScopeGroups } from './application/airtable/airtable-mcp-manifest';
import { createZohoCrmTool } from './application/tools/families/zoho-crm.tool';
import { createZohoBooksTool } from './application/tools/families/zoho-books.tool';
import { createWebSearchTool } from './application/tools/families/web-search.tool';
import { createSkillPublishingTool } from './application/tools/families/skill-publishing.tool';
import { createMemoryPublishingTool } from './application/tools/families/memory-publishing.tool';
import { createMemoryRecallTool } from './application/tools/families/memory-recall.tool';
import { createDataExportTool } from './application/tools/families/data-export.tool';
import { createRunCommandTool } from './application/tools/families/run-command.tool';
import { createScheduledWorkflowsTool } from './application/tools/families/scheduled-workflows.tool';
import { createMailAutomationsTool } from './application/tools/families/mail-automations.tool';
import { createSemrushTool } from './application/tools/families/semrush.tool';
import { createOmsSiteDataTool } from './application/tools/families/oms-site-data.tool';
import { ScheduledDesktopChannelAdapter } from './infrastructure/channels/desktop/scheduled-desktop.adapter';
import { ScheduledLarkDmChannelAdapter } from './infrastructure/channels/lark/scheduled-lark-dm.adapter';
import { LarkMessagingClient } from './infrastructure/channels/lark/clients/lark-messaging.client';
import { ToolExecutor } from './application/gateway/tool-executor';
import { GatewayDispatcher } from './application/gateway/gateway-dispatcher';
import { GoogleWorkspaceContractBootstrapService } from './application/gateway/google-workspace-contract-bootstrap.service';
import { WorkResolutionService } from './application/gateway/work-resolution.service';
import { WorkBootstrapService } from './application/gateway/work-bootstrap.service';
import {
  InMemoryApprovalIntentRepository,
  LocalApprovalIntentService,
} from './application/gateway/local-approval-intent.service';
import { MediaOcrService } from './application/gateway/media-ocr.service';
import { ConnectionRateLimitService } from './application/governance/connection-rate-limit.service';
import { ApiKeyExhaustionNotifier } from './application/governance/api-key-exhaustion.notifier';
import type { ApiKeyExhaustionNotifierPort } from './application/governance/api-key-exhaustion.notifier';
import { isApiKeyExhausted } from './application/governance/api-key-exhaustion.classifier';
import type { ApiKeyProvider } from './application/governance/api-key-exhaustion.classifier';

// AI model
import { createDeepSeek } from '@ai-sdk/deepseek';
import { wrapLanguageModel, type LanguageModel } from 'ai';

type ZohoBooksOrganizationPayload = {
  organizations?: Array<{
    organization_id?: string;
    is_default?: boolean;
    is_default_org?: boolean;
  }>;
};

const GATEWAY_PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;


export interface Container {
  env: TypedEnv;
  larkAdapter: LarkChannelAdapter;
  channelRegistry: ChannelAdapterRegistry;
  channelIdentityRepo: ChannelIdentityRepository;
  conversationRepo: ConversationRepository;
  ingressReceiptRepo: IngressReceiptRepository;
  logger: import('./shared/logger').Logger;
  prisma: ReturnType<typeof getPrismaClient>;
  /** Hot-path app cache: permissions, OAuth tokens, agent defs. → REDIS_CACHE_URL */
  cache: CachePort;
  /** Memory system + short-lived keys: nonces, knowledge-share, Cloudinary. → REDIS_MEMORY_URL */
  memoryCache: CachePort;
  /** Resolved Redis URL for the BullMQ queue — exposed so workers can share the same URL. */
  queueRedisUrl: string;
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
  skillAccessEnforcement: SkillAccessRepository;
  skillRegistryAdminService: SkillRegistryAdminService;
  // Agent admin CRUD
  departmentAdminService: DepartmentAdminService;
  desktopDepartmentManagementService: DesktopDepartmentManagementService;
  // Lark user OAuth
  larkOAuthService: LarkOAuthService;
  // OAuth surfaces (used by auth routes)
  googleOAuthService: GoogleOAuthService;
  googleConnectionAuthorization: GoogleConnectionAuthorizationService;
  googleConnectionContinuationQueue: GoogleConnectionContinuationQueue;
  connectionAuthorizationRepo: ConnectionAuthorizationRepository;
  mailOpsRepo: MailOpsRepository;
  mailOpsWorker: MailOpsWorker;
  canvaMcpOAuthService: CanvaMcpOAuthService;
  airtableMcpOAuthService: AirtableMcpOAuthService;
  /** AITable has no OAuth; this proves a pasted API key before it is stored. */
  aitableKeyVerifier: AitableKeyVerifier;
  integrationConnectionRepo: IntegrationConnectionRepository;
  companySerperConnectionRepo: CompanySerperConnectionRepository;
  companySerperService: CompanySerperService;
  semrushService: SemrushService;
  companyOmsConnectionRepo: CompanyOmsConnectionRepository;
  companyOmsSiteDataService: CompanyOmsSiteDataService;
  zohoTokenService: ZohoTokenService;
  zohoConnectionRepo: ZohoConnectionRepository;
  // Observability
  executionRepo: ExecutionRepository;
  executionQueryService: ExecutionQueryService;
  auditService: AuditService;
  tokenUsageService: TokenUsageService;
  proxyKeyStore: ProxyKeyStore;
  llmProxyService: LlmProxyService;
  apiKeyExhaustionNotifier: ApiKeyExhaustionNotifierPort;
  // HITL approval
  approvalGate: ApprovalGateService;
  approvalCardHandler: LarkApprovalCardHandler;
  approvalResumer: ApprovalResumerService;
  approvalInbox: ApprovalInboxService;
  dataExportQueue: DataExportQueue;
  dataExportSources: DataExportSourceRegistry;
  googleWorkspaceExportSink: GoogleWorkspaceExportSink;
  resolveGoogleExportAuth: (companyId: string) => Promise<{
    readonly accessToken: string;
    readonly readerDomain: string;
  }>;
  airtableConnectionResolver: ResolveAirtableMcpConnection;
  larkIngressQueue: LarkIngressQueue;
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
  // Persistent memory
  mem0Service: Mem0Service | null;
  larkMemoryReviewService: LarkMemoryReviewService;
  // Group chat context
  chatContextService: LarkChatContextService;
  /** Renders the shared room conversation for an isolated Pi run. */
  groupContextHydrator: GroupContextHydrator;
  channelDeliveryRepo: ChannelDeliveryRepository;
  /** Cross-replica execution lane ownership. */
  laneLeaseHolder: LaneLeaseHolder;
  /** One queued-message notice per busy stretch of a lane. */
  busyLaneNotices: BusyLaneNotices;
  // Lark contacts (for directory sync)
  larkContactsClient: LarkContactsClient;
  // Pi/Desktop capability gateway
  gatewayDispatcher: GatewayDispatcher;
  /** Container runtime shared by the Lark webhook and the scheduled-workflow poller. */
  larkPiRuntime: import('./application/runtime/lark-pi-runtime.service').LarkPiRuntimeService;
}

export async function buildContainer(env: TypedEnv): Promise<Container> {
  const logger = createPinoLogger({
    isDev:   env.NODE_ENV !== 'production',
    level:   env.LOG_LEVEL,
    service: 'advance-backend',
  });
  const gmailPubsubConfig = getGmailPubSubConfig(env);

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
  const connectionRateLimits = new ConnectionRateLimitService({
    repository: new PrismaConnectionGovernanceRepository(prisma),
    store: new RedisRateLimitStore(getRedisClient(cacheRedisUrl)),
    clock: systemClock,
  });

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
  const omsEncryptionKey = env.OMS_CONNECTION_ENCRYPTION_KEY ?? env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
  const companyOmsConnectionRepo = new CompanyOmsConnectionRepository(prisma, omsEncryptionKey);
  const conversationRepo      = new ConversationRepository(prisma, cache);
  const channelIdentityRepo   = new ChannelIdentityRepository(prisma, cache);
  const larkChatContextRepo   = new LarkChatContextRepository(prisma);
  const ingressReceiptRepo    = new IngressReceiptRepository(prisma);
  const connectionAuthorizationRepo = new ConnectionAuthorizationRepository(
    prisma,
    env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '',
  );
  const mailOpsRepo = new MailOpsRepository(prisma);

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


  // Every backend-side model is DeepSeek. The two jobs below are background
  // work — group-room compaction and persona learning — and both run without a
  // live invoker to borrow inference from. Keeping them on one provider means a
  // room's stored summary cannot silently change voice between runs.
  //
  // The SDK resolves a missing key at request time, so startup stays
  // independent of this: with no key the callers fall back to their
  // deterministic paths rather than failing to boot.
  const deepSeek = createDeepSeek(env.DEEPSEEK_API_KEY ? { apiKey: env.DEEPSEEK_API_KEY } : {});
  const deepSeekModel = (modelId: string) => deepSeek(modelId);

  // Backend-side inference is now background work only.
  //
  // Every turn a user sees runs in the Pi container, which owns its own model
  // and its own session compaction. Two jobs still need a model here, and
  // neither has a live invoker to borrow inference from: the ambient group-room
  // rollover below (a room transcript condensed so later turns get the context
  // without replaying it) and persona learning, which pins its own DeepSeek
  // model further down.
  //
  // The `provider`/`modelId` columns on aiModelTargetConfig — the "primary"
  // model — no longer select anything; they belonged to the deleted in-backend
  // engine. Only the fast target is read.
  // Pinned to DeepSeek, not the configurable target: Divo runs DeepSeek
  // everywhere else, and letting a room's compaction silently switch provider
  // would change what every later turn in that room is told it already knows.
  const summarizationModel = deepSeekModel(env.GROUP_SUMMARY_MODEL_ID);

  const chatContextService = new LarkChatContextService({
    repo: larkChatContextRepo,
    // Request RBAC stays with the live run; this only condenses stored text.
    model: summarizationModel,
    logger: logger.child({ service: 'chat-context' }),
  });
  const groupContextHydrator = new GroupContextHydrator({
    chatContext: chatContextService,
    logger,
  });

  // Late-bound: concrete notifier is created after Lark/approval wiring.
  let apiKeyExhaustionNotifier: ApiKeyExhaustionNotifier | undefined;
  const apiKeyExhaustionFacade: ApiKeyExhaustionNotifierPort = {
    notifyIfExhausted: (input) =>
      apiKeyExhaustionNotifier?.notifyIfExhausted(input) ?? Promise.resolve({ notified: false }),
    clear: (companyId, provider) =>
      apiKeyExhaustionNotifier?.clear(companyId, provider) ?? Promise.resolve(),
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
  const serperClient        = new SerperClient({
    apiKey:    env.SERPER_API_KEY ?? '',
    timeoutMs: env.SERPER_TIMEOUT_MS,
  });
  const serperEncryptionKey = env.SERPER_CONNECTION_ENCRYPTION_KEY ?? env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '';
  const companySerperConnectionRepo = new CompanySerperConnectionRepository(prisma, serperEncryptionKey);
  const companySerperService = new CompanySerperService(
    companySerperConnectionRepo,
    memoryCache,
    env.SERPER_TIMEOUT_MS,
    logger.child({ service: 'company-serper' }),
    env.SERPER_API_KEY ?? '',
  );
  const semrushService = new SemrushService(
    new SemrushClient({ timeoutMs: env.SEMRUSH_TIMEOUT_MS }),
    env.SEMRUSH_API_KEY,
    logger.child({ service: 'semrush' }),
    env.SEMRUSH_API_KEY_WEBHOOK_URL,
  );
  const companyOmsSiteDataService = new CompanyOmsSiteDataService(
    companyOmsConnectionRepo,
    new OmsSiteDataClient({ timeoutMs: env.OMS_SITE_DATA_TIMEOUT_MS }),
    memoryCache,
    logger.child({ service: 'company-oms-site-data' }),
    env.OMS_SITE_DATA_API_KEY ?? '',
  );

  // ── Lark user OAuth ───────────────────────────────────────────────────────
  const larkOAuthRedirectUri =
    env.LARK_OAUTH_REDIRECT_URI ?? `${env.BACKEND_PUBLIC_URL}/api/lark/auth/callback`;
  // Logged because it is silently wrong by default. The sign-in link is built
  // by the ingress worker, which has no HTTP request to read a Host from, so an
  // unset `LARK_OAUTH_REDIRECT_URI` sends every user to localhost — and the
  // failure only shows up in the browser of whoever tapped the link.
  logger.info('lark.oauth.redirect_uri.resolved', {
    redirectUri: larkOAuthRedirectUri,
    source: env.LARK_OAUTH_REDIRECT_URI ? 'LARK_OAUTH_REDIRECT_URI' : 'BACKEND_PUBLIC_URL',
  });
  const larkOAuthService = new LarkOAuthService(
    env.LARK_APP_ID,
    env.LARK_APP_SECRET,
    larkOAuthRedirectUri,
    env.LARK_API_BASE_URL,
  );

  // ── Google OAuth + connection registry ───────────────────────────────────
  const integrationConnectionRepo = new IntegrationConnectionRepository(prisma, env);
  const googleOAuthService        = new GoogleOAuthService({ env, cache, logger: logger.child({ service: 'google-oauth' }) });
  const googleCallbackBase = new URL(
    env.GOOGLE_OAUTH_REDIRECT_URI ?? env.BACKEND_PUBLIC_URL,
  );
  const googleConnectionCallbackUrl = new URL(
    '/api/google/connection/callback',
    googleCallbackBase.origin,
  ).toString();
  logger.info('google.connection.redirect_uri.resolved', {
    redirectUri: googleConnectionCallbackUrl,
    source: env.GOOGLE_OAUTH_REDIRECT_URI
      ? 'GOOGLE_OAUTH_REDIRECT_URI_origin'
      : 'BACKEND_PUBLIC_URL',
  });
  const googleConnectionAuthorization = new GoogleConnectionAuthorizationService({
    intentRepo: connectionAuthorizationRepo,
    googleOAuth: googleOAuthService,
    connectionRepo: integrationConnectionRepo,
    callbackUrl: googleConnectionCallbackUrl,
    logger,
  });
  let deliverGoogleConnect:
    | ((input: {
        url: string;
        reason: string;
        chatId: string;
        replyToMessageId: string;
        replyInThread: boolean;
      }) => Promise<boolean>)
    | undefined;
  const beginGoogleAuthorization = async (input: {
    toolId: string;
    reason: string;
    runContext: import('./domain/orchestration/run-context').RunContext;
  }) => {
    const target = input.runContext.connectionAuthorization;
    if (!target || !deliverGoogleConnect) {
      return { status: 'unavailable' as const };
    }
    const issued = await googleConnectionAuthorization.issue({
      companyId: String(input.runContext.companyId),
      userId: String(input.runContext.userId),
      ...(input.runContext.departmentId
        ? { departmentId: String(input.runContext.departmentId) }
        : {}),
      ...target,
      requestedToolIds: [input.toolId],
    });
    if (issued.outcome === 'already_pending') {
      return { status: 'already_pending' as const, intentId: issued.intentId };
    }
    const delivered = await deliverGoogleConnect({
      url: issued.authorizeUrl,
      reason: input.reason,
      chatId: target.chatId,
      replyToMessageId: target.originalMessageId,
      replyInThread: target.replyInThread,
    });
    if (!delivered) {
      logger.error('google.authorization.card_delivery_failed', {
        intentId: issued.intentId,
        companyId: input.runContext.companyId,
        userId: input.runContext.userId,
      });
      return { status: 'unavailable' as const };
    }
    return { status: 'sent' as const, intentId: issued.intentId };
  };
  const googleWorkspaceMcpSchemas = new GoogleWorkspaceMcpSchemaCatalog();
  const canvaMcpOAuthService      = new CanvaMcpOAuthService({ env, cache: memoryCache, logger });
  const airtableMcpOAuthService   = new AirtableMcpOAuthService({ env, cache: memoryCache, logger });
  const airtableMcpSchemas        = new AirtableMcpSchemaCatalog();
  // AITable authenticates with a personal API key, so there is no OAuth service
  // to construct — only the check that proves a pasted key before it is stored.
  const aitableKeyVerifier        = createAitableKeyVerifier({ baseUrl: env.AITABLE_BASE_URL });

  async function getGoogleWorkspaceMcpConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId?: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopeGroups: readonly (readonly string[])[];
    readonly markLastUsed?: boolean;
    readonly abortSignal?: AbortSignal;
  }) {
    input.abortSignal?.throwIfAborted();
    if (!googleOAuthService.isConfigured()) return { status: 'unavailable' as const };

    const accessible = await integrationConnectionRepo.listAccessibleGoogleConnections({
      companyId: input.companyId,
      userId: input.userId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.abortSignal?.throwIfAborted();
    if (!accessible.ok) return { status: 'unavailable' as const };
    const scopeEligible = accessible.value.filter((connection) =>
      hasGoogleScopeGroups(connection.scopes, input.requiredScopeGroups),
    );
    const selection = selectAccessibleConnection({
      connections: scopeEligible,
      filteredOut: accessible.value.filter((connection) => !scopeEligible.includes(connection)),
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
      return {
        status: 'unavailable' as const,
        reason: selection.reason,
        accessible: publicConnectionChoices(selection.accessible),
      };
    }

    const selectedConnectionId = selection.connection.connectionId;
    const connection = await integrationConnectionRepo.findAccessibleGoogleConnection({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: selectedConnectionId,
      minimumAccess: input.minimumAccess,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.abortSignal?.throwIfAborted();
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
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      input.abortSignal?.throwIfAborted();
      if (input.markLastUsed !== false) {
        await integrationConnectionRepo.touchLastUsed(selectedConnectionId);
        input.abortSignal?.throwIfAborted();
      }
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
      input.abortSignal?.throwIfAborted();
      logger.warn('google.connection.token_resolution_failed', {
        companyId: input.companyId,
        userId: input.userId,
        connectionId: selectedConnectionId,
        error: String(error),
      });
      return { status: 'unavailable' as const };
    }
  }

  async function resolveMailAutomationGoogleConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId?: string;
    readonly abortSignal?: AbortSignal;
  }) {
    input.abortSignal?.throwIfAborted();
    if (!googleOAuthService.isConfigured()) {
      return {
        status: 'unavailable' as const,
        reason: 'Google OAuth is not configured for Divo.',
      };
    }
    const accessible = await integrationConnectionRepo
      .listAccessibleGoogleConnections(input);
    input.abortSignal?.throwIfAborted();
    if (!accessible.ok) {
      return {
        status: 'unavailable' as const,
        reason: 'Google connections could not be loaded.',
      };
    }
    const owned = accessible.value.filter(connection =>
      connection.ownerType === 'user'
      && connection.ownerUserId === input.userId,
    );
    const eligible = owned.filter(connection =>
      connection.access !== 'read_only'
      && hasGoogleScopeGroups(connection.scopes, [
        [GOOGLE_SCOPE.gmailModify],
        [GOOGLE_SCOPE.gmailSend],
      ]),
    );
    const selection = selectAccessibleConnection({
      connections: eligible,
      filteredOut: accessible.value.filter(
        connection => !eligible.includes(connection),
      ),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      minimumAccess: 'read_write',
    });
    if (selection.status === 'choose_connection') {
      return {
        status: 'choose_connection' as const,
        connections: publicConnectionChoices(selection.connections),
      };
    }
    if (selection.status === 'unavailable') {
      return {
        status: 'unavailable' as const,
        reason:
          'Mail Ops needs a user-owned Google account with Gmail read, watch, '
          + 'and send access. Connect or reconnect Google to continue.',
      };
    }
    if (!selection.connection.accountEmail) {
      return {
        status: 'unavailable' as const,
        reason:
          'The selected Google connection has no verified mailbox address. '
          + 'Reconnect Google to continue.',
      };
    }
    return {
      status: 'resolved' as const,
      connectionId: selection.connection.connectionId,
      mailboxEmail: selection.connection.accountEmail,
    };
  }

  async function resolveGoogleExportAuth(companyId: string): Promise<{
    readonly accessToken: string;
    readonly readerDomain: string;
  }> {
    const configured = await prisma.companyCapabilityGovernance.findUnique({
      where: {
        companyId_capabilityId: { companyId, capabilityId: DATA_EXPORT_CAPABILITY_ID },
      },
      select: { policyJson: true },
    });
    const profile = configured ? parseDataExportProfile(configured.policyJson) : null;
    if (!profile) {
      throw new Error('Company data export is not configured by an administrator');
    }
    const resolved = await integrationConnectionRepo.findCompanyGoogleExportConnection({
      companyId,
      connectionId: profile.googleConnectionId,
    });
    if (!resolved.ok || !resolved.value?.refreshToken) {
      throw new Error('Configured Google export connection is unavailable');
    }
    const connection = resolved.value;
    const refreshToken = connection.refreshToken;
    if (!refreshToken) throw new Error('Configured Google export connection has no refresh token');
    if (connection.accountEmail?.trim().toLowerCase() !== profile.accountEmail) {
      throw new Error('Configured Google export account identity changed; administrator acknowledgement is required again');
    }
    if (!hasGoogleScopeGroups(connection.scopes, [
      [GOOGLE_SCOPE.driveFull, GOOGLE_SCOPE.driveFile],
      [GOOGLE_SCOPE.sheetsFull],
    ])) {
      throw new Error('Configured Google export connection no longer has Drive and Sheets write scopes');
    }
    const accessToken = await googleOAuthService.getValidAccessToken({
      companyId,
      userId: `data-export:${connection.id}`,
      refreshToken,
    });
    await integrationConnectionRepo.touchLastUsed(connection.id);
    return { accessToken, readerDomain: profile.readerDomain };
  }

  /**
   * Resolve one Airtable account for a tool call, refreshing its token first
   * when needed. Airtable rotates the refresh token on every refresh and kills
   * the previous one, so the rotated pair is persisted before the client is
   * handed out — a dropped write would strand the connection.
   */
  async function getAirtableMcpConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId?: string;
    readonly minimumAccess: 'read_only' | 'read_write';
    readonly requiredScopeGroups: readonly (readonly string[])[];
  }) {
    if (!airtableMcpOAuthService.isConfigured()) return { status: 'unavailable' as const };

    const accessible = await integrationConnectionRepo.listAccessibleAirtableConnections({
      companyId: input.companyId,
      userId: input.userId,
    });
    if (!accessible.ok) return { status: 'unavailable' as const };
    const scopeEligible = accessible.value.filter((connection) =>
      hasAirtableScopeGroups(connection.scopes, input.requiredScopeGroups),
    );
    // Airtable still discards the reason, so this changes nothing it reports
    // today. Declared anyway: the moment it does surface one, a silent filter
    // here would reproduce Google's "you have no account" falsehood exactly.
    const selection = selectAccessibleConnection({
      connections: scopeEligible,
      filteredOut: accessible.value.filter((connection) => !scopeEligible.includes(connection)),
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
      if (requested && !hasAirtableScopeGroups(requested.scopes, input.requiredScopeGroups)) {
        logger.warn('airtable.connection.missing_required_scope', {
          companyId: input.companyId,
          userId: input.userId,
          connectionId: input.connectionId,
          requiredScopeGroups: input.requiredScopeGroups,
        });
      }
      return { status: 'unavailable' as const };
    }

    const selectedConnectionId = selection.connection.connectionId;
    const connection = await integrationConnectionRepo.findAccessibleAirtableConnection({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: selectedConnectionId,
      minimumAccess: input.minimumAccess,
    });
    if (!connection.ok || !connection.value?.accessToken) {
      return { status: 'unavailable' as const };
    }

    let accessToken = connection.value.accessToken;
    const expiresSoon = connection.value.accessTokenExpiresAt
      ? connection.value.accessTokenExpiresAt.getTime() <= Date.now() + 60_000
      : false;
    if (expiresSoon && connection.value.refreshToken) {
      try {
        const metadata = connection.value.tokenMetadata ?? {};
        const refreshed = await airtableMcpOAuthService.refreshConnectionTokens({
          accessToken,
          refreshToken: connection.value.refreshToken,
          ...(connection.value.tokenType ? { tokenType: connection.value.tokenType } : {}),
          scopes: connection.value.scopes,
          ...(metadata['oauthClientInformation'] ? { clientInformation: metadata['oauthClientInformation'] as any } : {}),
          ...(metadata['oauthDiscoveryState'] ? { discoveryState: metadata['oauthDiscoveryState'] as any } : {}),
        });
        const persisted = await integrationConnectionRepo.updateAirtableTokens({
          companyId: input.companyId,
          connectionId: selectedConnectionId,
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
        // Airtable already invalidated the previous refresh token. Using the
        // new access token without having stored its partner would leave the
        // connection unrecoverable, so fail closed and let the member retry.
        if (!persisted.ok) {
          logger.error('airtable.connection.rotated_token_persist_failed', {
            companyId: input.companyId,
            connectionId: selectedConnectionId,
            error: persisted.error.message,
          });
          return { status: 'unavailable' as const };
        }
        accessToken = refreshed.accessToken;
      } catch (error) {
        logger.warn('airtable.connection.refresh_failed', {
          companyId: input.companyId,
          userId: input.userId,
          connectionId: selectedConnectionId,
          error: String(error),
        });
        return { status: 'unavailable' as const };
      }
    }

    await integrationConnectionRepo.touchLastUsed(selectedConnectionId);
    return {
      status: 'resolved' as const,
      connection: {
        client: new AirtableMcpClient(accessToken, airtableMcpSchemas, env.AIRTABLE_MCP_URL),
      },
    };
  }

  /**
   * Resolve one AITable account for a tool call.
   *
   * Shaped like the Airtable resolver, minus every token-refresh branch: an
   * AITable key is a static credential with no expiry and nothing to rotate.
   * What replaces that branch is the opposite problem — a key its owner
   * regenerated upstream is dead permanently, so connections in `needs_key`
   * are declared as filtered-out rather than dropped. That is what lets the
   * selector say "you have an account, it needs a new key" instead of the
   * falsehood "you have no AITable account".
   */
  async function getAitableConnection(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId?: string;
    readonly minimumAccess: 'read_only' | 'read_write';
  }) {
    const accessible = await integrationConnectionRepo.listAccessibleAitableConnections({
      companyId: input.companyId,
      userId: input.userId,
    });
    if (!accessible.ok) return { status: 'unavailable' as const };

    const selection = selectAitableConnection({
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
    if (selection.status === 'needs_key') {
      logger.warn('aitable.connection.needs_key', {
        companyId: input.companyId,
        userId: input.userId,
        connectionIds: selection.connections.map(connection => connection.connectionId),
      });
      return {
        status: 'needs_key' as const,
        connections: publicConnectionChoices(selection.connections),
      };
    }
    if (selection.status === 'unavailable') return { status: 'unavailable' as const };

    const selectedConnectionId = selection.connection.connectionId;
    const connection = await integrationConnectionRepo.findAccessibleAitableConnection({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: selectedConnectionId,
      minimumAccess: input.minimumAccess,
    });
    if (!connection.ok || !connection.value?.accessToken) {
      return { status: 'unavailable' as const };
    }

    await integrationConnectionRepo.touchLastUsed(selectedConnectionId);
    return {
      status: 'resolved' as const,
      connectionId: selectedConnectionId,
      connection: {
        client: new AitableClient(connection.value.accessToken, env.AITABLE_BASE_URL),
      },
    };
  }

  /**
   * Records that AITable rejected a stored key, so the connection stops being
   * offered and starts asking to be repaired. Called by the tool family when a
   * live call comes back 401 — the only moment we can learn this, since there
   * is no refresh cycle to discover it during.
   */
  async function markAitableConnectionNeedsKey(companyId: string, connectionId: string): Promise<void> {
    const marked = await integrationConnectionRepo.markAitableConnectionNeedsKey({ companyId, connectionId });
    if (!marked.ok) {
      logger.error('aitable.connection.mark_needs_key_failed', {
        companyId,
        connectionId,
        error: marked.error.message,
      });
      return;
    }
    logger.warn('aitable.connection.key_rejected', { companyId, connectionId });
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
    if ((!connectionId || !userId) && !zohoTokenService.isConfigured()) {
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

  const dataExportQueue = new DataExportQueue(queueRedisUrl);
  const larkIngressQueue = new LarkIngressQueue(queueRedisUrl);
  const googleConnectionContinuationQueue =
    new GoogleConnectionContinuationQueue(queueRedisUrl);
  const personaLearningQueue = new PersonaLearningQueue(
    queueRedisUrl,
    env.REDIS_PERSONA_LEARNING_QUEUE_NAME,
  );
  const personaLearningService = new PersonaLearningService({
    prisma,
    queue: personaLearningQueue,
    extractor: new DeepSeekPersonaLearningExtractor(
      deepSeekModel(env.PERSONA_LEARNING_MODEL_ID),
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
      model: env.VISION_OCR_MODEL,
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
  const managerTeachPersonaProcessor = new ManagerTeachPersonaProcessor({
    prisma,
    logger,
    minConfidence: env.MANAGER_TEACH_PERSONA_MIN_CONFIDENCE,
    maxEvidenceBytes: env.MANAGER_TEACH_EVIDENCE_MAX_MB * 1_024 * 1_024,
    maxInputChars: env.MANAGER_TEACH_PERSONA_MAX_INPUT_CHARS,
    modelProvider: 'deepseek',
    modelId: env.MANAGER_TEACH_PERSONA_MODEL,
  });
  const managerTeachService = new ManagerTeachService({
    prisma,
    queue: managerTeachQueue,
    logger,
    mediaProcessor: managerTeachMediaProcessor,
    personaProcessor: managerTeachPersonaProcessor,
    maxVideoBytes: env.MANAGER_TEACH_MAX_VIDEO_MB * 1_024 * 1_024,
    rawRetentionHours: env.MANAGER_TEACH_RAW_RETENTION_HOURS,
    uploadDir: managerTeachUploadDir,
  });

  // ── Zoho Books paginated client + finance ops ────────────────────────────
  const zohoPaginatedBooksClient = new ZohoBooksPaginatedClient(zohoTokenService, env.ZOHO_API_BASE_URL);
  const dataExportSources = new DataExportSourceRegistry();
  dataExportSources.register(new AirtableDataExportSource(getAirtableMcpConnection));
  dataExportSources.register(new ZohoBooksDataExportSource(
    zohoPaginatedBooksClient,
    async () => {
      const { getExchangeRates, buildCurrencyUtilities } = await import('./application/zoho/exchange-rate.service');
      return buildCurrencyUtilities(await getExchangeRates());
    },
  ));
  const googleWorkspaceExportSink = new GoogleWorkspaceExportSink();

  const zohoFinanceOps = new ZohoFinanceOps(
    zohoPaginatedBooksClient,
    logger.child({ service: 'zoho-finance-ops' }),
    env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
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

  // ── Skills ────────────────────────────────────────────────────────────────
  const skillRepo    = new SkillRepository(prisma);
  const skillCatalog = new SkillCatalogService({
    repo: skillRepo,
    logger,
  });
  const skillAccessEnforcement = new SkillAccessRepository(prisma);
  const skillRegistryAdminService = new SkillRegistryAdminService({
    prisma,
    logger: logger.child({ service: 'skill-registry-admin' }),
  });

  // Adapter: company-owned Serper pool → gateway web-search tool.
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
  for (const tool of createGoogleWorkspaceMcpTools({
    getConnection: getGoogleWorkspaceMcpConnection,
    beginAuthorization: beginGoogleAuthorization,
  })) {
    toolRegistry.register(tool);
  }
  toolRegistry.register(createMailAutomationsTool({
    repo: mailOpsRepo,
    pubsubReady: Boolean(gmailPubsubConfig),
    resolveConnection: resolveMailAutomationGoogleConnection,
    beginAuthorization: beginGoogleAuthorization,
  }));
  toolRegistry.register(createCanvaDesignTool({ getClient: getCanvaMcpClient }));
  for (const tool of createAirtableMcpTools({
    getConnection: getAirtableMcpConnection,
  })) {
    toolRegistry.register(tool);
  }
  for (const tool of createAitableTools({
    getConnection: getAitableConnection,
    onKeyRejected: markAitableConnectionNeedsKey,
  })) {
    toolRegistry.register(tool);
  }
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
    exportQueue:     dataExportQueue,
    inlineThreshold: env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
  }));
  toolRegistry.register(createWebSearchTool({ client: webSearchClientAdapter }));
  toolRegistry.register(createSkillPublishingTool({ prisma }));
  toolRegistry.register(createMemoryPublishingTool({ mem0: mem0Service }));
  toolRegistry.register(createMemoryRecallTool({ mem0: mem0Service, departmentRepo: deptRepo }));
  toolRegistry.register(createDataExportTool({ queue: dataExportQueue }));
  toolRegistry.register(createSemrushTool({
    service: semrushService,
    cloudinary: cloudinaryAdapter,
    audit: auditService,
    csvLinkTtl: env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
    apiKeyExhaustion: apiKeyExhaustionFacade,
  }));
  toolRegistry.register(createOmsSiteDataTool({
    service: companyOmsSiteDataService,
    cloudinary: cloudinaryAdapter,
    audit: auditService,
    csvLinkTtl: env.ZOHO_BOOKS_CSV_LINK_TTL_SECONDS,
  }));
  toolRegistry.register(createRunCommandTool());
  toolRegistry.register(createScheduledWorkflowsTool({ prisma }));

  logger.info('tool.registry.built', { toolCount: toolRegistry.ids().length, tools: toolRegistry.ids() });

  // ── Engine primitives ──────────────────────────────────────────────────

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
  const workResolution = new WorkResolutionService({
    skillCatalog,
    skillAccessEnforcement,
    managerPersonaRuntime: managerPersonaRuntimeService,
  });
  const workContractBootstrap = new GoogleWorkspaceContractBootstrapService(
    getGoogleWorkspaceMcpConnection,
  );
  // One instance for both surfaces. The desktop gateway and the backend-hosted
  // channels must resolve the same accounts and contracts, or the model works
  // blind on whichever one was left out.
  const workBootstrap = new WorkBootstrapService({
    toolRegistry,
    connectionRegistry: integrationConnectionRepo,
    workContractBootstrap,
  });
  // The Lark supervisor passes its freshly resolved permission snapshot into
  // this executor; the approval gate is supplied per invocation after the
  // channel adapter is available below.
  const larkRuntimeToolExecutor = new ToolExecutor({
    toolRegistry,
    permissions,
    connectionRateLimits,
    connectionRegistry: integrationConnectionRepo,
    logger: logger.child({ service: 'lark-runtime-tool-executor' }),
    clock: systemClock,
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



  // ── Channels ───────────────────────────────────────────────────────────
  const channelDeliveryRepo = new ChannelDeliveryRepository(prisma);
  // Owner identity must be unique per process and stable for its lifetime: a
  // lease is renewed and released by matching on it, so two replicas sharing an
  // ID could renew each other's lanes.
  const laneOwnerId = `${env.NODE_ENV ?? 'dev'}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const laneLeaseHolder = new LaneLeaseHolder({
    repo: new ExecutionLaneLeaseRepository(prisma),
    channel: 'lark',
    ownerId: laneOwnerId,
    logger: logger.child({ component: 'lane-lease' }),
  });
  const busyLaneNotices = new BusyLaneNotices();
  const larkPiRuntime = new (await import('./application/runtime/lark-pi-runtime.service')).LarkPiRuntimeService({
    prisma,
    logger,
    memberJwtSecret: env.MEMBER_JWT_SECRET,
    backendUrl: env.BACKEND_PUBLIC_URL,
    controllerUrl: env.PI_LARK_CONTROLLER_URL,
    instanceId: env.PI_LARK_RUNTIME_INSTANCE_ID,
    leaseTtlSeconds: env.PI_RUNTIME_LEASE_TTL_SECONDS,
    runTimeoutMs: env.PI_LARK_RUN_TIMEOUT_MS,
  });

  const larkAdapter = new LarkChannelAdapter({
    env,
    logger: logger.child({ channel: 'lark' }),
    deliveryRepo: channelDeliveryRepo,
  });
  await larkAdapter.initialize();
  deliverGoogleConnect = async (input) => {
    const card = await larkAdapter.sendCardToChat(
      input.chatId,
      buildGoogleConnectCard(input),
      input.replyToMessageId,
      input.replyInThread,
    );
    if (card.ok) return true;
    logger.warn('google.authorization.card_delivery_fallback', {
      chatId: input.chatId,
      error: card.error.message,
    });
    const fallback = await larkAdapter.sendToChatId(
      input.chatId,
      googleConnectFallbackText(input),
      input.replyToMessageId,
      undefined,
      input.replyInThread,
    );
    return fallback.ok;
  };
  const gmailHistoryClient = new GmailHistoryClient();
  const mailOpsWorker = new MailOpsWorker({
    repo: mailOpsRepo,
    gmail: gmailHistoryClient,
    resolveAccessToken: async input => {
      const connection = await integrationConnectionRepo.findAccessibleGoogleConnection({
        ...input,
        minimumAccess: 'read_write',
      });
      if (!connection.ok) throw connection.error;
      if (!connection.value?.refreshToken) {
        throw new Error('Mail Ops Google connection is unavailable.');
      }
      return googleOAuthService.getValidAccessToken({
        companyId: input.companyId,
        userId: `connection:${input.connectionId}`,
        refreshToken: connection.value.refreshToken,
      });
    },
    authorizeRule: async input => {
      const connection = await integrationConnectionRepo
        .findAccessibleGoogleConnection({
          companyId: input.companyId,
          userId: input.userId,
          connectionId: input.connectionId,
          minimumAccess: 'read_write',
        });
      if (!connection.ok) throw connection.error;
      if (
        connection.value?.ownerType !== 'user'
        || connection.value.ownerUserId !== input.userId
        || !connection.value.refreshToken
        || !hasGoogleScopeGroups(connection.value.scopes, [
          [GOOGLE_SCOPE.gmailModify],
          [GOOGLE_SCOPE.gmailSend],
        ])
      ) return false;
      const identity = await channelIdentityRepo.resolveByUserId(
        input.userId,
        input.companyId,
      );
      if (!identity.ok) throw identity.error;
      if (!identity.value) return false;
      const resolved = await permissions.resolve({
        companyId: asCompanyId(input.companyId),
        userId: asUserId(input.userId),
        companyRole: asCompanyRoleSlug(identity.value.aiRole),
        ...(input.departmentId
          ? { departmentId: asDepartmentId(input.departmentId) }
          : {}),
        channel: 'lark',
      });
      if (!resolved.ok) throw resolved.error;
      return resolved.value.allowedActionsByTool
        .get(asToolId('mailAutomations'))
        ?.has('execute') ?? false;
    },
    deliverLark: async input => {
      const sent = await larkAdapter.sendToChatId(
        input.chatId,
        input.text,
        undefined,
        input.idempotencyKey,
      );
      if (!sent.ok) throw sent.error;
      return sent.value;
    },
    logger,
    ...(gmailPubsubConfig
      ? { pubsubTopicName: gmailPubsubConfig.topic }
      : {}),
  });
  const channelRegistry = new ChannelAdapterRegistry();
  channelRegistry.register(larkAdapter);

  // ── HITL Approval ─────────────────────────────────────────────────────
  const approvalRepo     = new RuntimeApprovalRepository(prisma);
  const approvalResolver = new ApprovalResolverService(prisma);
  apiKeyExhaustionNotifier = new ApiKeyExhaustionNotifier({
    cache,
    approvalResolver,
    larkAdapter,
    logger: logger.child({ service: 'api-key-exhaustion' }),
  });
  companySerperService.bindExhaustionNotifier(apiKeyExhaustionNotifier);
  companyOmsSiteDataService.bindExhaustionNotifier(apiKeyExhaustionNotifier);
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
    connectionRateLimits,
  );
  const gatewayToolExecutor = new ToolExecutor({
    toolRegistry,
    permissions,
    approvalGate,
    connectionRateLimits,
    logger: logger.child({ service: 'gateway-tool-executor' }),
    clock:  systemClock,
  });
  const automationPlanExecutor = new AutomationPlanExecutor({
    approvalRepo,
    channelIdentityRepo,
    permissions,
    skillCatalog,
    skillAccessEnforcement,
    approvalGate,
    approvalResolver,
    toolExecutor: gatewayToolExecutor,
    logger: logger.child({ service: 'automation-plan-executor' }),
  });
  const approvalResumer  = new ApprovalResumerService({
    approvalRepo,
    larkAdapter,
    channelIdentityRepo,
    approvalGate,
    toolExecutor: gatewayToolExecutor,
    permissions,
    automationPlanExecutor,
    logger: logger.child({ service: 'approval-resumer' }),
  });
  const approvalCardHandler = new LarkApprovalCardHandler(
    approvalRepo,
    approvalResumer,
    larkAdapter,
    logger.child({ service: 'approval-card-handler' }),
    auditService,
  );

  // The same decisions the Lark card carries, reachable by anyone signed in.
  // `onResolvedCard` is what stops a delivered card from still offering buttons
  // for a decision that was already made in the inbox.
  const approvalInbox = new ApprovalInboxService({
    approvals: approvalRepo,
    resumer: approvalResumer,
    logger: logger.child({ service: 'approval-inbox' }),
    audit: auditService,
    onResolvedCard: async (messageId, decision, byName) => {
      await larkAdapter.updateMessageById(messageId, buildApprovalResolutionCard(decision, byName, new Date()));
    },
  });

  const localApprovalIntents = new LocalApprovalIntentService({
    toolExecutor: gatewayToolExecutor,
    permissions,
    skillCatalog,
    skillAccessEnforcement,
    repository: new InMemoryApprovalIntentRepository(),
    clock: systemClock,
    logger: logger.child({ service: 'gateway-local-approval' }),
  });
  const automationPlanService = new AutomationPlanService({
    toolExecutor: gatewayToolExecutor,
    permissions,
    skillCatalog,
    skillAccessEnforcement,
    approvalRepo,
    approvalResolver,
    approvalGate,
    larkAdapter,
    logger: logger.child({ service: 'automation-plan' }),
  });
  const mediaOcr = new MediaOcrService(env, logger);
  mediaOcr.bindExhaustionNotifier(apiKeyExhaustionNotifier);
  const gatewayDispatcher = new GatewayDispatcher({
    permissions,
    toolRegistry,
    skillCatalog,
    toolExecutor: gatewayToolExecutor,
    localApprovalIntents,
    connectionRegistry: integrationConnectionRepo,
    workContractBootstrap,
    mediaOcr,
    managerPersonaRuntime: managerPersonaRuntimeService,
    workResolution,
    managerTeachService,
    automationPlanService,
    skillAccessEnforcement,
    auditService,
    logger: logger.child({ service: 'gateway-dispatcher' }),
  });

  const larkMemoryReviewService = new LarkMemoryReviewService(
    memoryCache,
    larkAdapter,
    larkRuntimeToolExecutor,
    permissions,
    approvalGate,
    logger,
  );

  logger.info('container.built', { channels: channelRegistry.keys() });

  return {
    env,
    larkAdapter,
    channelRegistry,
    channelIdentityRepo,
    conversationRepo,
    ingressReceiptRepo,
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
    skillAccessEnforcement,
    skillRegistryAdminService,
    // Agent admin CRUD
    departmentAdminService,
    desktopDepartmentManagementService,
    // Lark user OAuth
    larkOAuthService,
    // OAuth surfaces
    googleOAuthService,
    googleConnectionAuthorization,
    googleConnectionContinuationQueue,
    connectionAuthorizationRepo,
    mailOpsRepo,
    mailOpsWorker,
    canvaMcpOAuthService,
    airtableMcpOAuthService,
    aitableKeyVerifier,
    integrationConnectionRepo,
    companySerperConnectionRepo,
    companySerperService,
    semrushService,
    companyOmsConnectionRepo,
    companyOmsSiteDataService,
    zohoConnectionRepo,
    zohoTokenService,
    // Observability
    executionRepo,
    executionQueryService,
    auditService,
    tokenUsageService,
  proxyKeyStore,
  llmProxyService,
  apiKeyExhaustionNotifier: apiKeyExhaustionFacade,
  // HITL approval
  approvalGate,
    approvalCardHandler,
    approvalResumer,
    approvalInbox,
    // Document RAG
    dataExportQueue,
    dataExportSources,
    googleWorkspaceExportSink,
    resolveGoogleExportAuth,
    airtableConnectionResolver: getAirtableMcpConnection,
    larkIngressQueue,
    personaLearningQueue,
    personaLearningService,
    personaLearningPromotionService,
    managerPersonaRuntimeService,
    managerPersonaRevisionService,
    managerTeachQueue,
    managerTeachService,
    managerTeachUploadDir,
    cloudinaryAdapter,
    // Knowledge Share
    mem0Service,
    larkMemoryReviewService,
    // Message serialization
    chatSerializer,
    // Group chat context
    chatContextService,
    groupContextHydrator,
    channelDeliveryRepo,
    laneLeaseHolder,
    busyLaneNotices,
    // Lark contacts (for directory sync)
    larkContactsClient,
    // Pi/Desktop capability gateway
    gatewayDispatcher,
    // Container runtime, shared by the Lark webhook and the scheduler.
    larkPiRuntime,
    // Scheduled workflow executor
    scheduledWorkflowService: new (await import('./application/scheduling/scheduled-workflow.service')).ScheduledWorkflowService({
      prisma,
      piRuntime: larkPiRuntime,
      runTimeoutMs: env.PI_LARK_RUN_TIMEOUT_MS,
      channelAdapters: {
        lark: larkAdapter,
        larkDm: new ScheduledLarkDmChannelAdapter({
          client: new LarkMessagingClient({
            appId: env.LARK_APP_ID,
            appSecret: env.LARK_APP_SECRET,
            ...(env.LARK_API_BASE_URL ? { apiBaseUrl: env.LARK_API_BASE_URL } : {}),
            logger: logger.child({ service: 'scheduled-lark-dm-client' }),
          }),
          logger: logger.child({ service: 'scheduled-lark-dm-channel' }),
        }),
        desktop: new ScheduledDesktopChannelAdapter({
          prisma,
          logger: logger.child({ service: 'scheduled-desktop-channel' }),
        }),
      },
      channelIdentityRepo,
      logger: logger.child({ service: 'scheduled-workflow' }),
      clock:  systemClock,
      pollIntervalMs: env.SCHEDULED_WORKFLOW_POLL_INTERVAL_MS,
    }),
  };
}
