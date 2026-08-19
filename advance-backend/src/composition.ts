import 'dotenv/config';
import { resolve } from 'node:path';
import type { TypedEnv } from './config/env';
import {
  getGmailPubSubConfig,
  resolveRedisUrl,
} from './config/env';
import { RuntimeApprovalRepository } from './infrastructure/persistence/runtime-approval.repository';
import { DecisionService } from './application/decision/decision.service';
import { LarkDecisionCourier } from './infrastructure/channels/lark/lark-decision.courier';
import { LarkDecisionCardHandler } from './infrastructure/channels/lark/lark-decision-card.handler';
import { buildDecisionResolvedCard } from './infrastructure/channels/lark/lark-decision-card';
import { buildApprovalResolutionCard } from './application/approval/approval-card-builder';
import { ApprovalResolverService } from './application/approval/approval-resolver.service';
import { ApprovalGateService } from './application/approval/approval-gate.service';
import { ApprovalResumerService } from './application/approval/approval-resumer.service';
import { AutomationPlanService } from './application/gateway/automation-plan.service';
import { AutomationPlanExecutor } from './application/gateway/automation-plan.executor';
import { LarkApprovalCardHandler } from './infrastructure/channels/lark/lark-approval-card.handler';
import { LarkWorkbookConversionCardHandler } from './infrastructure/channels/lark/lark-workbook-conversion-card.handler';
import { ConsoleLogger } from './shared/logger';
import { createPinoLogger } from './shared/pino-logger';
import { systemClock } from './shared/clock';

// Infra
import { getPrismaClient } from './infrastructure/persistence/prisma.client';
import { getRedisClient } from './infrastructure/cache/redis.client';
import { RedisCache } from './infrastructure/cache/redis-cache';
import { SiteIconService } from './application/icons/site-icon.service';
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
import { GoogleOAuthService, GoogleTokenRefreshError } from './infrastructure/google/google-oauth.service';
import { GoogleWorkspaceMcpClient } from './infrastructure/google/google-workspace-mcp.client';
import { GoogleWorkspaceMcpSchemaCatalog } from './infrastructure/google/google-workspace-mcp-schema.catalog';
import { GoogleWorkspaceGatewayClient } from './infrastructure/google/google-workspace-gateway.client';
import { CanvaMcpOAuthService } from './infrastructure/canva/canva-mcp-oauth.service';
import { CanvaMcpClient } from './infrastructure/canva/canva-mcp.client';
import { AirtableMcpOAuthService } from './infrastructure/airtable/airtable-mcp-oauth.service';
import { AirtableMcpClient } from './infrastructure/airtable/airtable-mcp.client';
import { AirtableMcpSchemaCatalog } from './infrastructure/airtable/airtable-mcp-schema.catalog';
import { AitableClient } from './infrastructure/aitable/aitable.client';
import { ShopifyOAuthService } from './infrastructure/shopify/shopify-oauth.service';
import { ShopifyAdminClient } from './infrastructure/shopify/shopify-admin.client';
import { ShopifyConnectionService } from './application/shopify/shopify-connection.service';
import { ShopifyService } from './application/shopify/shopify.service';
import { ShopifyAuthorizationService } from './application/shopify/shopify-authorization.service';
import { IntegrationOAuthAttemptRepository } from './infrastructure/persistence/integration-oauth-attempt.repository';
import { ShopifyRunProvenanceRepository } from './infrastructure/persistence/shopify-run-provenance.repository';
import { createAitableKeyVerifier, type AitableKeyVerifier } from './application/aitable/aitable-connect.service';
import { selectAitableConnection } from './application/aitable/aitable-connection-selection';
import {
  CONNECTION_REAUTHORIZATION_REQUIRED,
  IntegrationConnectionRepository,
} from './infrastructure/persistence/integration-connection.repository';
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
import { SemrushWebClient } from './infrastructure/semrush/semrush-web.client';
import { SemrushService } from './application/semrush/semrush.service';
import { createSemrushKeyProvider } from './application/semrush/semrush-key.provider';
import { MenhoodQueryService } from './application/menhood/menhood-query.service';
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
import { ZohoBooksPaginatedClient } from './infrastructure/zoho/zoho-books-paginated.client';
import { ConversationAttachmentAssetService } from './application/conversation-attachments/conversation-attachment-asset.service';
import { ConversationAttachmentService } from './application/conversation-attachments/conversation-attachment.service';
import { CloudinaryConversationAttachmentObjectStore } from './infrastructure/conversation-attachments/cloudinary-conversation-attachment-object.store';
import { PrismaConversationAttachmentAssetStore } from './infrastructure/persistence/conversation-attachment-asset.repository';
import { PrismaConversationAttachmentStore } from './infrastructure/persistence/conversation-attachment.repository';
import { ChannelAttachmentSource } from './application/zoho/channel-attachment-source';
import { LarkConversationAttachmentSource } from './infrastructure/zoho/lark-conversation-attachment.source';
import { WebConversationAttachmentSource } from './infrastructure/zoho/web-conversation-attachment.source';
import { PrismaStagedInvoiceStore } from './infrastructure/persistence/zoho-invoice-staging.repository';
import { PrismaStagedPurchaseOrderStore } from './infrastructure/persistence/zoho-purchase-order-staging.repository';
import { PrismaStagedBillStore } from './infrastructure/persistence/zoho-bill-staging.repository';
import { createInvoiceReviewer } from './application/zoho/zoho-invoice-reviewer';
import { LarkFileClient } from './infrastructure/channels/lark/clients/lark-file.client';
import { ZohoCrmPaginatedClient } from './infrastructure/zoho/zoho-crm-paginated.client';
import { CloudinaryAdapter } from './infrastructure/cloudinary/cloudinary.adapter';
import { ZohoFinanceOps } from './application/zoho/zoho-finance-ops';
import { ZohoCrmOps } from './application/zoho/zoho-crm-ops';
import type { CachePort } from './shared/cache';

// Observability
import { ExecutionRepository } from './infrastructure/persistence/execution.repository';
import { ExecutionQueryService } from './application/observability/execution-query.service';
import { RunLatencyRecorder } from './application/observability/run-latency-recorder';
import { ExecutionRunLifecycle } from './application/observability/execution-run-lifecycle';
import { AuditService } from './application/observability/audit.service';
import { TokenUsageService } from './application/observability/token-usage.service';
import { ProxyKeyStore } from './application/proxy/proxy-key.store';
import { LlmProxyService } from './application/proxy/llm-proxy.service';
import { SkillRepository } from './infrastructure/persistence/skill.repository';
import { SkillAccessRepository } from './infrastructure/persistence/skill-access.repository';
import { SkillCatalogService } from './application/skills/skill-catalog.service';
import { SkillRegistryAdminService } from './application/skills/skill-registry-admin.service';
import { RuntimeContextLifecycle } from './application/runtime/runtime-context-lifecycle';

// Application
import { PermissionServiceImpl } from './application/permissions/permission.service';
import type { PermissionService } from './application/permissions/permission.service';
import { ChannelAdapterRegistry } from './application/channels/channel.adapter';
import { ToolRegistry } from './application/tools/tool-registry';
// Multi-agent layer
import { DepartmentAdminService } from './application/departments/department-admin.service';
import { DesktopDepartmentManagementService } from './application/desktop/desktop-department-management.service';
import { ChatMessageSerializer } from './application/channels/chat-message-serializer';

// Workbook conversion and async ingress
import { WorkbookConversionQueue } from './application/artifacts/workbook-conversion.queue';
import { WorkbookConversionConfirmationService } from './application/artifacts/workbook-conversion.service';
import { GoogleDriveXlsxConversionWorker } from './application/artifacts/google-drive-xlsx-conversion.worker';
import { GoogleDriveXlsxConversionConsumer } from './application/artifacts/google-drive-xlsx-conversion.consumer';
import { GoogleDriveXlsxConversionCheckpointStore } from './application/artifacts/google-drive-xlsx-conversion.checkpoint.store';
import { WorkbookConversionLarkDelivery } from './application/artifacts/workbook-conversion-lark-delivery';
import { RedisWorkbookConversionLarkDeliveryStore } from './application/artifacts/workbook-conversion-lark-delivery.store';
import { GoogleDriveXlsxConversionAdapter } from './infrastructure/google/google-drive-xlsx-conversion.adapter';
import { parseGoogleDriveXlsxReference } from './application/artifacts/google-drive-xlsx-resource-reference';
import { GoogleDriveXlsxResourceResolver } from './application/artifacts/google-drive-xlsx-resource-resolver';
import { parseGoogleSheetReference } from './application/artifacts/google-sheet-resource-reference';
import { GoogleSheetResourceResolver } from './application/artifacts/google-sheet-resource-resolver';
import { GoogleSheetResourceProbeClient } from './infrastructure/google/google-sheet-resource-probe';
import { LarkIngressQueue } from './application/lark-ingress/lark-ingress.queue';
import {
  GoogleConnectionContinuationQueue,
} from './application/connections/google-connection-continuation';
import {
  GoogleConnectionAuthorizationService,
} from './application/connections/google-connection-authorization.service';
import { RunOriginStore } from './application/connections/run-origin.store';
import { createLarkChatDestinationAuthorizer } from './application/mail-ops/lark-chat-destination';
import { createMailRuleWriter } from './application/mail-ops/mail-rule-writer';
import {
  mailRulePermission,
  mailRuleRefusal,
  type MailRuleOperation,
} from './application/mail-ops/mail-rule-permission';
import { createMailRuleExternalApproval } from './application/mail-ops/mail-rule-external-approval';
import { createMailRuleCompiler } from './application/mail-ops/mail-rule-compiler';
import { createMailRuleJudge } from './application/mail-ops/mail-rule-judge';
import { createMailBriefComposer } from './application/mail-ops/mail-brief';
import { createMailBriefOnboarding } from './application/mail-ops/mail-brief-onboarding';
import { createMailBriefRunner } from './application/mail-ops/mail-brief.runner';
import {
  DEFAULT_MAIL_BRIEF_SCHEDULE,
  nextMailBriefRunAt,
} from './application/mail-ops/mail-brief.schedule';
import {
  createBeginGoogleAuthorization,
  type DeliverGoogleConnectCard,
} from './application/connections/begin-google-authorization';
import { MailOpsWorker } from './application/mail-ops/mail-ops.worker';
import { MailOpsConnectionUnavailableError } from './application/mail-ops/mail-ops.types';
import { GmailHistoryClient } from './infrastructure/google/gmail-history.client';
import { MailOpsRepository } from './infrastructure/persistence/mail-ops.repository';
import { MailOpsReadRepository } from './infrastructure/persistence/mail-ops-read.repository';
import { MailOpsMailboxNotifier } from './application/mail-ops/mail-ops-notifier';
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
import { VideoUnderstandingService } from './application/video-understanding/video-understanding.service';
import { ConversationVideoService } from './application/conversation-video/conversation-video.service';
import { ConversationVideoStore } from './application/conversation-video/conversation-video.store';
import { ManagerTeachPersonaProcessor } from './application/persona-learning/manager-teach-persona.processor';
import { PeepshowVideoExtractor } from './infrastructure/media/peepshow-video.extractor';
import { OpenRouterFrameReader } from './infrastructure/ai/ocr/openrouter-frame.reader';
import { OpenAiVideoTranscriber } from './infrastructure/ai/transcription/openai-video.transcriber';

// Central knowledge authority and semantic recall projection
import type { MemoryService } from './application/knowledge/semantic-memory.port';
import { HindsightMemoryService } from './infrastructure/knowledge/hindsight-memory.service';
import { LarkKnowledgeReviewService } from './application/knowledge/lark-knowledge-review.service';
import { RunEffectReceiptStore } from './application/runtime/run-effect-receipt.store';
import { KnowledgeReviewDecisionQueue } from './application/knowledge/knowledge-review-decision.queue';
import { KnowledgeMutationService } from './application/knowledge/knowledge-mutation.service';
import { KnowledgeProjectionService } from './application/knowledge/knowledge-projection.service';
import { KnowledgeOperationsService } from './application/knowledge/knowledge-operations.service';
import { KnowledgeRecallService } from './application/knowledge/knowledge-recall.service';
import { KnowledgeResourceQueryService } from './application/knowledge/knowledge-resource-query.service';
import { PersonalMemoryCommandService } from './application/knowledge/personal-memory-command.service';
import { KnowledgeLearningQueue } from './application/knowledge/knowledge-learning.queue';
import { KnowledgeLearningService } from './application/knowledge/knowledge-learning.service';
import { DeepSeekKnowledgeLearningExtractor } from './application/knowledge/knowledge-learning.extractor';
import { PrismaKnowledgeMutationStore } from './infrastructure/persistence/knowledge-mutation.repository';
import { DefaultKnowledgeContentValidator } from './application/knowledge/knowledge-content-validator';
import { KnowledgeFileService } from './application/knowledge/knowledge-file.service';
import { PrismaKnowledgeFileAssetRepository } from './infrastructure/persistence/knowledge-file-asset.repository';
import { CloudinaryKnowledgeFileStore } from './infrastructure/knowledge/cloudinary-knowledge-file.store';
import { KnowledgeDocumentIndexService } from './application/knowledge/knowledge-document-index.service';
import { KnowledgeDocumentSearchService } from './application/knowledge/knowledge-document-search.service';
import { PrismaKnowledgeDocumentRepository } from './infrastructure/persistence/knowledge-document.repository';
import { DefaultKnowledgeDocumentParser } from './infrastructure/knowledge/default-knowledge-document.parser';
import { OpenRouterKnowledgeOcr } from './infrastructure/knowledge/openrouter-knowledge.ocr';
import { ClamAvKnowledgeFileScanner } from './infrastructure/knowledge/clamav-knowledge-file.scanner';

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
import { createKnowledgeTool } from './application/tools/families/knowledge.tool';
import { createRunCommandTool } from './application/tools/families/run-command.tool';
import { createScheduledWorkflowsTool } from './application/tools/families/scheduled-workflows.tool';
import {
  createMailAutomationsTool,
  mailOpsConnectionUnavailableMessage,
} from './application/tools/families/mail-automations.tool';
import { createSemrushTool } from './application/tools/families/semrush.tool';
import { createOmsSiteDataTool } from './application/tools/families/oms-site-data.tool';
import { createMenhoodDataTool } from './application/tools/families/menhood-data.tool';
import { createShopifyTools } from './application/tools/families/shopify.tool';
import { ScheduledLarkDmChannelAdapter } from './infrastructure/channels/lark/scheduled-lark-dm.adapter';
import { LarkMessagingClient } from './infrastructure/channels/lark/clients/lark-messaging.client';
import { ToolExecutor } from './application/gateway/tool-executor';
import { GatewayDispatcher } from './application/gateway/gateway-dispatcher';
import { GoogleWorkspaceContractBootstrapService } from './application/gateway/google-workspace-contract-bootstrap.service';
import { AirtableContractBootstrapService } from './application/gateway/airtable-contract-bootstrap.service';
import { CompositeWorkContractBootstrap } from './application/gateway/composite-contract-bootstrap.service';
import { WorkResolutionService } from './application/gateway/work-resolution.service';
import { WorkBootstrapService } from './application/gateway/work-bootstrap.service';
import { BusinessActionService } from './application/approval/business-action.service';
import { MediaOcrService } from './application/gateway/media-ocr.service';
import { ConnectionRateLimitService } from './application/governance/connection-rate-limit.service';
import { ApiKeyExhaustionNotifier } from './application/governance/api-key-exhaustion.notifier';
import type { ApiKeyExhaustionNotifierPort } from './application/governance/api-key-exhaustion.notifier';
import { isApiKeyExhausted } from './application/governance/api-key-exhaustion.classifier';
import type { ApiKeyProvider } from './application/governance/api-key-exhaustion.classifier';

// AI model
import { createDeepSeek } from '@ai-sdk/deepseek';
import { wrapLanguageModel, type LanguageModel } from 'ai';

const GATEWAY_PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the one approval-policy switch used by the runtime composition.
 *
 * The canonical setting is deployable in every environment. The old variable
 * remains a non-production compatibility shim only; it cannot weaken or alter
 * production policy.
 */
export const resolveApprovalGateOptions = (
  env: Pick<
    TypedEnv,
    | 'NODE_ENV'
    | 'DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS'
    | 'DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS'
    | 'DIVO_APPROVAL_CARDS_ENABLED'
    | 'DIVO_MAIL_OPS_ADMIN_NEEDS_EXTERNAL_APPROVAL'
  >,
): {
  disableManagerSelfBypass: boolean;
  suppressCardDelivery: boolean;
  disableCompanyAdminExternalForwardExemption: boolean;
} => ({
  disableManagerSelfBypass:
    env.DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS
    || (env.NODE_ENV !== 'production' && env.DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS),
  /*
   * The exemption is on unless somebody asks for it back.
   *
   * Stated as "does an admin still need approval" rather than "is the exemption
   * disabled", because the double negative is how an operator sets the opposite
   * of what they meant.
   */
  disableCompanyAdminExternalForwardExemption:
    env.DIVO_MAIL_OPS_ADMIN_NEEDS_EXTERNAL_APPROVAL === true,
  /*
   * Never in production. An approval nobody is told about is an approval
   * nobody answers, and the tool call waiting on it simply stops.
   *
   * Suppressed only on an explicit `false`, not on absence: the schema supplies
   * the default, and a caller who hands over a partial env should get cards,
   * not silence.
   */
  suppressCardDelivery:
    env.NODE_ENV !== 'production' && env.DIVO_APPROVAL_CARDS_ENABLED === false,
});


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
  /** Favicons for cited domains, fetched by us so no third party learns them. */
  siteIcons: SiteIconService;
  /** Short-lived security/workflow keys: nonces, run effects, uploads. → REDIS_MEMORY_URL (legacy env name) */
  ephemeralCache: CachePort;
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
  runtimeContextLifecycle: RuntimeContextLifecycle;
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
  mailOpsReadRepo: MailOpsReadRepository;
  /** The web route's create path for a mail rule. */
  writeMailRule: ReturnType<typeof createMailRuleWriter>;
  /** Asks a manager about a forward the web route refused to make unasked. */
  requestMailRuleExternalApproval: ReturnType<typeof createMailRuleExternalApproval>;
  /** Which department a signed-in member is acting in, for surfaces with no run context. */
  resolveMemberDepartmentId: (input: {
    companyId: string;
    userId: string;
  }) => Promise<string | null>;
  /**
   * Whether a member may do this to a mail rule — asked when they ask, not only
   * at delivery, and answered per operation rather than once for all of them.
   */
  canRunMailRules: (input: {
    companyId: string;
    userId: string;
    companyRole: string;
    departmentId?: string;
    operation: MailRuleOperation;
  }) => Promise<{ kind: 'allowed' | 'denied' | 'unavailable'; message?: string }>;
  /** One sentence into a draft rule. Creates nothing. */
  compileMailRule: ReturnType<typeof createMailRuleCompiler>;
  mailBriefOnboarding: ReturnType<typeof createMailBriefOnboarding>;
  mailOpsWorker: MailOpsWorker;
  canvaMcpOAuthService: CanvaMcpOAuthService;
  airtableMcpOAuthService: AirtableMcpOAuthService;
  /** AITable has no OAuth; this proves a pasted API key before it is stored. */
  aitableKeyVerifier: AitableKeyVerifier;
  integrationConnectionRepo: IntegrationConnectionRepository;
  shopifyAuthorizationService: ShopifyAuthorizationService;
  companySerperConnectionRepo: CompanySerperConnectionRepository;
  companySerperService: CompanySerperService;
  semrushService: SemrushService;
  menhoodQueryService: MenhoodQueryService;
  companyOmsConnectionRepo: CompanyOmsConnectionRepository;
  companyOmsSiteDataService: CompanyOmsSiteDataService;
  zohoTokenService: ZohoTokenService;
  zohoConnectionRepo: ZohoConnectionRepository;
  // Observability
  executionRepo: ExecutionRepository;
  executionQueryService: ExecutionQueryService;
  runLatencyRecorder: RunLatencyRecorder;
  executionRunLifecycle: ExecutionRunLifecycle;
  auditService: AuditService;
  tokenUsageService: TokenUsageService;
  proxyKeyStore: ProxyKeyStore;
  llmProxyService: LlmProxyService;
  apiKeyExhaustionNotifier: ApiKeyExhaustionNotifierPort;
  // HITL approval
  approvalGate: ApprovalGateService;
  approvalCardHandler: LarkApprovalCardHandler;
  workbookConversionCardHandler: LarkWorkbookConversionCardHandler;
  approvalResumer: ApprovalResumerService;
  /** The one place Divo asks a person something and hears back. */
  decisions: DecisionService;
  decisionCardHandler: LarkDecisionCardHandler;
  businessActions: BusinessActionService;
  workbookConversionQueue: WorkbookConversionQueue;
  workbookConversionWorker: GoogleDriveXlsxConversionConsumer;
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
  // Non-authoritative semantic recall projection; Postgres knowledge follows.
  memoryService: MemoryService | null;
  knowledgeMutations: KnowledgeMutationService;
  knowledgeProjections: KnowledgeProjectionService;
  knowledgeOperations: KnowledgeOperationsService;
  knowledgeRecall: KnowledgeRecallService;
  knowledgeResources: KnowledgeResourceQueryService;
  knowledgeLearningQueue: KnowledgeLearningQueue;
  knowledgeLearningService: KnowledgeLearningService;
  knowledgeFileService: KnowledgeFileService;
  knowledgeDocumentSearch: KnowledgeDocumentSearchService;
  larkKnowledgeReviewService: LarkKnowledgeReviewService;
  knowledgeReviewDecisionQueue: KnowledgeReviewDecisionQueue;
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
  /** Files the member sent, indexed by name so a tool can attach one later. */
  conversationAttachments: ConversationAttachmentService;
  /** Browser-uploaded files held privately for provider attachment. */
  conversationAttachmentAssets: ConversationAttachmentAssetService;
  // Pi/Desktop capability gateway
  gatewayDispatcher: GatewayDispatcher;
  /** Container runtime shared by the Lark webhook and the scheduled-workflow poller. */
  larkPiRuntime: import('./application/runtime/lark-pi-runtime.service').LarkPiRuntimeService;
  /** The same runtime, driven from the browser. Not a second agent — a second view. */
  webRuns: import('./application/runtime/web-run.service').WebRunService;
  /** Video attached to a conversation: taken in, read, and thrown away. */
  /** Absent when the deployment has no vision or transcription key. */
  conversationVideo: import('./application/conversation-video/conversation-video.service').ConversationVideoService | undefined;
  /** Web runs in flight. They outlive the connection that started them. */
  webRunRegistry: import('./application/runtime/web-run-registry').WebRunRegistry;
  /** The reader's view of their own conversations: list, read, rename, delete. */
  webThreads: import('./infrastructure/persistence/web-thread.repository').WebThreadRepository;
  /** Documents the agent wrote, kept after the container that wrote them is gone. */
  artifacts: import('./infrastructure/persistence/artifact.repository').ArtifactRepository;
  /** What a member still has to do, read from their own Lark account. */
  openTasks: import('./application/work/open-tasks').OpenTasksDeps;
}

export interface BuildContainerOptions {
  /** Skip Lark bot-identity network call (safe for in-process harness CLIs). */
  readonly skipLarkInitialize?: boolean;
}

export async function buildContainer(
  env: TypedEnv,
  options: BuildContainerOptions = {},
): Promise<Container> {
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
  //   ephemeralRedisUrl → short-lived security/workflow keys. REDIS_MEMORY_URL
  //   is retained only as a deployment-compatible environment name.
  const queueRedisUrl  = resolveRedisUrl(env.REDIS_QUEUE_URL,  env.REDIS_URL);
  const cacheRedisUrl  = resolveRedisUrl(env.REDIS_CACHE_URL,  env.REDIS_URL);
  const ephemeralRedisUrl = resolveRedisUrl(env.REDIS_MEMORY_URL, env.REDIS_URL);

  const cache       = new RedisCache(getRedisClient(cacheRedisUrl));
  const ephemeralCache = new RedisCache(getRedisClient(ephemeralRedisUrl));
  /* On the hot cache rather than the ephemeral one: an icon is worth keeping
     for a month, and it is the only thing here whose value is the bytes rather
     than a permission or a token. */
  const siteIcons = new SiteIconService({ cache, logger });
  const runOrigins = new RunOriginStore(ephemeralCache);
  const connectionRateLimits = new ConnectionRateLimitService({
    repository: new PrismaConnectionGovernanceRepository(prisma),
    store: new RedisRateLimitStore(getRedisClient(cacheRedisUrl)),
    clock: systemClock,
  });

  // ── Observability ──────────────────────────────────────────────────────
  const executionRepo      = new ExecutionRepository(prisma);
  const shopifyRunProvenanceRepo = new ShopifyRunProvenanceRepository(prisma);
  const protectedDataRuns = {
    observe: async (input: {
      readonly companyId: string;
      readonly userId: string;
      readonly channel: string;
      readonly runId: string;
      readonly threadId?: string;
    }): Promise<void> => {
      const executionId = await executionRepo.findOrCreateByRequestId({
        requestId: input.runId,
        companyId: input.companyId,
        userId: input.userId,
        channel: input.channel,
        entrypoint: 'pi',
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
      await executionRepo.observeProtectedData(executionId, true);
    },
  };
  const shopifyDataRuns = {
    record: async (input: {
      readonly companyId: string;
      readonly userId: string;
      readonly channel: string;
      readonly runId: string;
      readonly threadId?: string;
      readonly connectionId: string;
      readonly toolId: string;
    }): Promise<void> => {
      const executionId = await executionRepo.findOrCreateByRequestId({
        requestId: input.runId,
        companyId: input.companyId,
        userId: input.userId,
        channel: input.channel,
        entrypoint: 'pi',
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
      await shopifyRunProvenanceRepo.record({
        companyId: input.companyId,
        executionRunId: executionId,
        connectionId: input.connectionId,
        toolId: input.toolId,
      });
    },
  };
  const executionQueryService = new ExecutionQueryService({
    repo:   executionRepo,
    logger: logger.child({ service: 'execution-query' }),
  });
  const runLatencyRecorder = new RunLatencyRecorder(
    executionRepo,
    logger.child({ service: 'run-latency' }),
  );
  const executionRunLifecycle = new ExecutionRunLifecycle(
    executionRepo,
    logger.child({ service: 'execution-run-lifecycle' }),
  );
  const auditService       = new AuditService(prisma, logger.child({ service: 'audit' }));
  const menhoodQueryService = new MenhoodQueryService(
    env,
    undefined,
    logger.child({ service: 'menhood-query' }),
  );
  const tokenUsageService  = new TokenUsageService(prisma, logger.child({ service: 'token-usage' }));
  const proxyKeyStore = new ProxyKeyStore({
    prisma,
    logger,
    encryptionKey: env.PROXY_KEY_ENCRYPTION_KEY ?? env.ZOHO_TOKEN_ENCRYPTION_KEY,
  });
  const llmProxyService = new LlmProxyService(prisma, logger.child({ service: 'llm-proxy-policy' }));

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
  const channelIdentityRepo   = new ChannelIdentityRepository(prisma, cache, logger);
  const larkChatContextRepo   = new LarkChatContextRepository(prisma);
  // Grounds a mail rule's Lark destination in a room Divo has actually been in
  // for this company. Until now nothing checked at all: the "use governed chat
  // discovery" rule lived only in prompt text, so any room the bot could reach
  // was a legal destination — including, where one Lark install serves two Divo
  // companies, the other company's rooms.
  const authorizeMailOpsLarkChat = createLarkChatDestinationAuthorizer(larkChatContextRepo);
  const ingressReceiptRepo    = new IngressReceiptRepository(prisma);
  const connectionAuthorizationRepo = new ConnectionAuthorizationRepository(
    prisma,
    env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '',
  );
  const mailOpsRepo = new MailOpsRepository(prisma);
  const mailOpsReadRepo = new MailOpsReadRepository(prisma);

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
    finalPermissionAliases: [{
      companyId: env.MENHOOD_COMPANY_ID,
      source: { toolId: 'airtableRecords', action: 'read' },
      target: { toolId: 'menhoodData', action: 'read' },
    }],
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
    ephemeralCache,
    env.SERPER_TIMEOUT_MS,
    logger.child({ service: 'company-serper' }),
    env.SERPER_API_KEY ?? '',
  );
  // Semrush uses validated www.semrush.com recipes only. Credentials stay
  // backend-owned; tool callers must never receive the web key or cookie.
  const semrushService = new SemrushService(
    new SemrushWebClient({
      timeoutMs: env.SEMRUSH_TIMEOUT_MS,
      ...(env.SEMRUSH_WEB_COOKIE ? { cookie: env.SEMRUSH_WEB_COOKIE } : {}),
    }),
    createSemrushKeyProvider({
      timeoutMs: env.SEMRUSH_TIMEOUT_MS,
      ...(env.SEMRUSH_WEB_API_KEY ? { environmentApiKey: env.SEMRUSH_WEB_API_KEY } : {}),
      ...(env.SEMRUSH_API_KEY_WEBHOOK_URL ? { webhookUrl: env.SEMRUSH_API_KEY_WEBHOOK_URL } : {}),
    }),
    logger.child({ service: 'semrush' }),
  );
  const companyOmsSiteDataService = new CompanyOmsSiteDataService(
    companyOmsConnectionRepo,
    new OmsSiteDataClient({ timeoutMs: env.OMS_SITE_DATA_TIMEOUT_MS }),
    ephemeralCache,
    logger.child({ service: 'company-oms-site-data' }),
    env.OMS_SITE_DATA_API_KEY ?? '',
    env.OMS_VENDOR_FETCH_API_KEY ?? '',
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
  const shopifyScopes = [...new Set(env.SHOPIFY_SCOPES.split(',').map(scope => scope.trim()).filter(Boolean))];
  const shopifyOAuthService = new ShopifyOAuthService({
    ...(env.SHOPIFY_CLIENT_ID ? { clientId: env.SHOPIFY_CLIENT_ID } : {}),
    ...(env.SHOPIFY_CLIENT_SECRET ? { clientSecret: env.SHOPIFY_CLIENT_SECRET } : {}),
    redirectUri: env.SHOPIFY_REDIRECT_URI ?? `${env.BACKEND_PUBLIC_URL}/api/shopify/auth/callback`,
    scopes: shopifyScopes,
    timeoutMs: env.SHOPIFY_TIMEOUT_MS,
    maxRetries: env.SHOPIFY_MAX_RETRIES,
    maxCallbackSkewSeconds: env.SHOPIFY_OAUTH_MAX_SKEW_SECONDS,
  });
  const shopifyAdminClient = new ShopifyAdminClient({
    apiVersion: env.SHOPIFY_API_VERSION,
    timeoutMs: env.SHOPIFY_TIMEOUT_MS,
    maxRetries: env.SHOPIFY_MAX_RETRIES,
  });
  const shopifyAuthorizationService = new ShopifyAuthorizationService({
    oauth: shopifyOAuthService,
    adminClient: shopifyAdminClient,
    attempts: new IntegrationOAuthAttemptRepository(prisma),
    connections: integrationConnectionRepo,
    scopes: shopifyScopes,
    apiVersion: env.SHOPIFY_API_VERSION,
  });
  const shopifyConnectionService = new ShopifyConnectionService({
    repository: integrationConnectionRepo,
    oauth: shopifyOAuthService,
  });
  const shopifyService = new ShopifyService({
    connections: shopifyConnectionService,
    client: shopifyAdminClient,
    apiVersion: env.SHOPIFY_API_VERSION,
  });
  const googleOAuthService        = new GoogleOAuthService({ env, cache, logger: logger.child({ service: 'google-oauth' }) });

  /**
   * The one way anything in Divo turns a stored Google grant into an access
   * token, so that a grant Google has revoked is written down exactly once.
   *
   * Every caller used to reach `getValidAccessToken` directly and rethrow, which
   * meant a revoked account was rediscovered on every tick and never recorded:
   * `IntegrationConnection.status` stayed `connected` forever while Mail Ops
   * failed every five minutes and Connected apps showed a green card. Routing
   * all of them through here makes the first rejection the one that marks it,
   * and every surface that filters on status then tells the same story.
   *
   * The error is still rethrown unchanged — this observes, it does not swallow.
   */
  const googleAccessTokenFor = async (input: {
    readonly companyId:    string;
    readonly connectionId: string;
    readonly refreshToken: string;
    /** Cache partition. Distinct per use so a scoped token is not reused elsewhere. */
    readonly cacheUserId:  string;
    readonly abortSignal?: AbortSignal;
  }): Promise<string> => {
    try {
      return await googleOAuthService.getValidAccessToken({
        companyId:    input.companyId,
        userId:       input.cacheUserId,
        refreshToken: input.refreshToken,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
    } catch (error) {
      if (error instanceof GoogleTokenRefreshError && error.code === 'refresh_rejected') {
        // Every cache partition this connection can occupy, not just the one
        // that happened to fail. A dead grant's access tokens are dead too, and
        // one left behind under the other prefix would be served to the first
        // call after the reconnect that was supposed to fix all of this.
        await Promise.all(
          [`connection:${input.connectionId}`]
            .map(cacheUserId => googleOAuthService.forgetCachedToken(input.companyId, cacheUserId)),
        );
        const marked = await integrationConnectionRepo.markGoogleReauthorizationRequired({
          companyId:    input.companyId,
          connectionId: input.connectionId,
        });
        // A failed write is logged and not thrown: the caller's own failure is
        // the more useful one to report, and the next refresh retries the mark.
        if (!marked.ok) {
          logger.error('google.connection.reauth_mark_failed', {
            companyId:    input.companyId,
            connectionId: input.connectionId,
            reason:       marked.error.message,
          });
        } else {
          logger.warn('google.connection.reauthorization_required', {
            companyId:    input.companyId,
            connectionId: input.connectionId,
            reason:       error.message,
          });
        }
      }
      throw error;
    }
  };

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
  let mailBriefOnboarding: ReturnType<typeof createMailBriefOnboarding>;
  const googleConnectionAuthorization = new GoogleConnectionAuthorizationService({
    intentRepo: connectionAuthorizationRepo,
    googleOAuth: googleOAuthService,
    connectionRepo: integrationConnectionRepo,
    mailBriefOnboarding: input => mailBriefOnboarding(input),
    callbackUrl: googleConnectionCallbackUrl,
    logger,
  });
  let deliverGoogleConnect: DeliverGoogleConnectCard | undefined;
  const beginGoogleAuthorization = createBeginGoogleAuthorization({
    runOrigins,
    authorization: googleConnectionAuthorization,
    deliverConnectCard: () => deliverGoogleConnect,
    logger,
  });
  const googleWorkspaceMcpSchemas = new GoogleWorkspaceMcpSchemaCatalog();
  const canvaMcpOAuthService      = new CanvaMcpOAuthService({ env, cache: ephemeralCache, logger });
  const airtableMcpOAuthService   = new AirtableMcpOAuthService({ env, cache: ephemeralCache, logger });
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
    readonly preferredOwnerType?: 'user' | 'company';
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
      ...(input.preferredOwnerType ? { preferredOwnerType: input.preferredOwnerType } : {}),
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
      const token = await googleAccessTokenFor({
        companyId:    input.companyId,
        connectionId: selectedConnectionId,
        cacheUserId:  `connection:${selectedConnectionId}`,
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
          connectionId: selectedConnectionId,
          ownerType: selection.connection.ownerType,
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

  async function resolveGoogleSheetReference(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly url: string;
    readonly connectionId?: string;
    readonly abortSignal?: AbortSignal;
  }) {
    input.abortSignal?.throwIfAborted();
    const parsedSheet = parseGoogleSheetReference(input.url);
    const parsedWorkbook = parsedSheet.ok ? null : parseGoogleDriveXlsxReference(input.url);
    const workbookReference = parsedWorkbook?.ok ? parsedWorkbook.reference : null;
    if (!parsedSheet.ok && !parsedWorkbook?.ok) {
      return { status: 'invalid_reference' as const, reason: parsedWorkbook?.reason ?? parsedSheet.reason };
    }
    if (!googleOAuthService.isConfigured()) return { status: 'no_connection' as const };

    const accessible = await integrationConnectionRepo.listAccessibleGoogleConnections({
      companyId: input.companyId,
      userId: input.userId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (!accessible.ok) throw accessible.error;
    input.abortSignal?.throwIfAborted();

    const probe = new GoogleSheetResourceProbeClient(async connectionId => {
      const resolved = await integrationConnectionRepo.findAccessibleGoogleConnection({
        companyId: input.companyId,
        userId: input.userId,
        connectionId,
        minimumAccess: 'read_write',
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      if (!resolved.ok) throw resolved.error;
      const connection = resolved.value;
      if (
        !connection?.refreshToken
        || connection.ownerType !== 'user'
        || connection.ownerUserId !== input.userId
        || connection.status !== 'connected'
        || !hasGoogleScopeGroups(connection.scopes, [
          [GOOGLE_SCOPE.driveFull],
          [GOOGLE_SCOPE.sheetsFull],
        ])
      ) {
        throw new Error('Selected personal Google account is no longer eligible for this file');
      }
      const token = await googleAccessTokenFor({
        companyId: input.companyId,
        connectionId,
        cacheUserId: `connection:${connectionId}`,
        refreshToken: connection.refreshToken,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      await integrationConnectionRepo.touchLastUsed(connectionId);
      input.abortSignal?.throwIfAborted();
      return token;
    });
    const resolutionInput = {
      userId: input.userId,
      accessible: accessible.value.filter(connection => connection.connectionId === input.connectionId),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    };
    if (parsedSheet.ok) {
      const resolver = new GoogleSheetResourceResolver(probe);
      if (!input.connectionId) {
        return resolver.listEligible({ userId: input.userId, accessible: accessible.value });
      }
      return resolver.resolve({ ...resolutionInput, reference: parsedSheet.reference });
    }
    const resolver = new GoogleDriveXlsxResourceResolver(probe);
    if (!input.connectionId) {
      return resolver.listEligible({ userId: input.userId, accessible: accessible.value });
    }
    return resolver.resolve({ ...resolutionInput, reference: workbookReference! });
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
    // Revoked accounts are asked for and then set aside, rather than never
    // fetched. They must not be selectable — a rule built on one can never
    // fire — but they are the difference between "reconnect Google" and "you
    // have no Google account", and the second is a lie told to somebody looking
    // straight at the account in their Connected apps list.
    const accessible = await integrationConnectionRepo
      .listAccessibleGoogleConnections({ ...input, includeReauthorizationRequired: true });
    input.abortSignal?.throwIfAborted();
    if (!accessible.ok) {
      return {
        status: 'unavailable' as const,
        reason: 'Google connections could not be loaded.',
      };
    }
    const live = accessible.value.filter(
      connection => connection.status !== CONNECTION_REAUTHORIZATION_REQUIRED,
    );
    const revokedOwned = accessible.value.filter(connection =>
      connection.status === CONNECTION_REAUTHORIZATION_REQUIRED
      && connection.ownerType === 'user'
      && connection.ownerUserId === input.userId,
    );
    const owned = live.filter(connection =>
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
      filteredOut: live.filter(
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
      // Only when nothing usable was found at all. Somebody with a working
      // account and a second, revoked one has an ordinary scope or access
      // problem on the working one, and telling them to reconnect the other
      // would send them to fix the account that is not the obstacle.
      if (eligible.length === 0 && revokedOwned.length > 0) {
        return {
          status: 'unavailable' as const,
          connectionState: 'reauthorization_required' as const,
          reason: mailOpsConnectionUnavailableMessage('reauthorization_required'),
        };
      }
      return {
        status: 'unavailable' as const,
        connectionState: selection.reason,
        reason: mailOpsConnectionUnavailableMessage(selection.reason),
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
    ephemeralCache,
    logger.child({ service: 'cloudinary' }),
  );

  const workbookConversionQueue = new WorkbookConversionQueue(queueRedisUrl);
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
  const videoUnderstanding = new VideoUnderstandingService({
    extractor: new PeepshowVideoExtractor({
      maxFrames: env.MANAGER_TEACH_MAX_FRAMES,
      width: env.MANAGER_TEACH_FRAME_WIDTH,
      sceneThreshold: env.MANAGER_TEACH_SCENE_THRESHOLD,
      timeoutMs: env.MANAGER_TEACH_MEDIA_TIMEOUT_SECONDS * 1_000,
    }),
    reader: new OpenRouterFrameReader({
      apiKey: env.OPENROUTER_API_KEY ?? '',
      model: env.VISION_OCR_MODEL,
    }),
    transcriber: new OpenAiVideoTranscriber({
      apiKey: env.OPENAI_API_KEY,
      model: env.MANAGER_TEACH_TRANSCRIPTION_MODEL,
      chunkSeconds: env.MANAGER_TEACH_TRANSCRIPTION_CHUNK_SECONDS,
    }),
    logger,
    readConcurrency: env.MANAGER_TEACH_OCR_CONCURRENCY,
    transcriptionModel: env.MANAGER_TEACH_TRANSCRIPTION_MODEL,
  });
  /* Video in an ordinary conversation. Shares the one reader with Teach — the
     work is identical, and a second copy of it would drift.
     Wired only when both halves of reading are configured. Without them the
     upload would still be accepted, the disk still filled and ffmpeg still run,
     only to fail at the last step — so the route says "not here" up front
     instead, which is what its 503 was written for. */
  const conversationVideo = env.OPENROUTER_API_KEY && env.OPENAI_API_KEY
    ? new ConversationVideoService({
      store: new ConversationVideoStore({
        rootDir: resolve(env.CONVERSATION_VIDEO_DIR),
        maxBytes: env.CONVERSATION_VIDEO_MAX_MB * 1_024 * 1_024,
      }),
      understanding: videoUnderstanding,
      maxConcurrentReads: env.CONVERSATION_VIDEO_READ_CONCURRENCY,
      maxCompanyBytes: env.CONVERSATION_VIDEO_COMPANY_BUDGET_MB * 1_024 * 1_024,
      maxReadsPerWindow: env.CONVERSATION_VIDEO_READS_PER_HOUR,
      maxTotalBytes: env.CONVERSATION_VIDEO_TOTAL_BUDGET_MB * 1_024 * 1_024,
      logger,
    })
    : undefined;
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
    understanding: videoUnderstanding,
    personaProcessor: managerTeachPersonaProcessor,
    maxVideoBytes: env.MANAGER_TEACH_MAX_VIDEO_MB * 1_024 * 1_024,
    rawRetentionHours: env.MANAGER_TEACH_RAW_RETENTION_HOURS,
    uploadDir: managerTeachUploadDir,
  });

  // ── Conversation attachment index ────────────────────────────────────────
  // Files the member sent, addressable by name. Written at the Lark webhook,
  // read by tools that put a document onto a provider record.
  const conversationAttachments = new ConversationAttachmentService(
    new PrismaConversationAttachmentStore(prisma),
    logger,
  );
  const invoiceDocumentParser = new DefaultKnowledgeDocumentParser({
    ocr: env.OPENROUTER_API_KEY
      ? new OpenRouterKnowledgeOcr({
          apiKey: env.OPENROUTER_API_KEY,
          model: env.VISION_OCR_MODEL,
          providerOrder: env.OPENROUTER_PROVIDER_ORDER,
        })
      : null,
    maxPages: env.KNOWLEDGE_DOCUMENT_MAX_PAGES,
    maxOcrPages: env.KNOWLEDGE_DOCUMENT_MAX_OCR_PAGES,
    maxArchiveEntries: env.KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_ENTRIES,
    maxArchiveUncompressedBytes: env.KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    maxArchiveCompressionRatio: env.KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_COMPRESSION_RATIO,
  });

  // ── Zoho Books paginated client + finance ops ────────────────────────────
  const zohoPaginatedBooksClient = new ZohoBooksPaginatedClient(zohoTokenService, env.ZOHO_API_BASE_URL);
  const zohoPaginatedCrmClient = new ZohoCrmPaginatedClient(zohoTokenService, env.ZOHO_API_BASE_URL);

  const zohoFinanceOps = new ZohoFinanceOps(
    zohoPaginatedBooksClient,
    logger.child({ service: 'zoho-finance-ops' }),
    env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
  );

  // ── Zoho CRM ops (client created above, beside the export source) ────────
  const zohoCrmOps = new ZohoCrmOps(
    zohoPaginatedCrmClient,
    logger.child({ service: 'zoho-crm-ops' }),
    env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
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
  const runtimeContextLifecycle = new RuntimeContextLifecycle({
    prisma,
    permissions,
    skillCatalog,
    skillAccessEnforcement,
    managerPersonaRuntime: managerPersonaRuntimeService,
    connectionRegistry: integrationConnectionRepo,
    logger,
  });

  // Adapter: company-owned Serper pool → gateway web-search tool.
  const webSearchClientAdapter = {
    async search(companyId: string, query: string, limit = 5): Promise<Array<{ title: string; url: string; snippet: string }>> {
      const result = await companySerperService.search(companyId, { query, num: limit });
      return result.organic.map(item => ({ title: item.title ?? '', url: item.link ?? '', snippet: item.snippet ?? '' })).filter(item => item.url);
    },
  };

  logger.info('hindsight.config', {
    enabled: env.HINDSIGHT_ENABLED,
    baseUrl: env.HINDSIGHT_URL,
    hasApiKey: !!env.HINDSIGHT_API_KEY,
  });

  const hindsightService = env.HINDSIGHT_ENABLED
    ? new HindsightMemoryService({
      baseUrl: env.HINDSIGHT_URL,
      ...(env.HINDSIGHT_API_KEY ? { apiKey: env.HINDSIGHT_API_KEY } : {}),
      maxResults: env.HINDSIGHT_MAX_RESULTS,
      recallMaxTokens: env.HINDSIGHT_RECALL_MAX_TOKENS,
      recallBudget: env.HINDSIGHT_RECALL_BUDGET,
      requestTimeoutMs: env.HINDSIGHT_REQUEST_TIMEOUT_MS,
      recallConcurrency: env.HINDSIGHT_RECALL_CONCURRENCY,
      logger: logger.child({ service: 'hindsight-memory' }),
    })
    : null;
  const memoryService: MemoryService | null = hindsightService;

  logger.info('hindsight.status', { enabled: !!memoryService });

  const knowledgeFileAssets = new PrismaKnowledgeFileAssetRepository(prisma);
  const knowledgeFileObjects = new CloudinaryKnowledgeFileStore(cloudinaryAdapter);
  const knowledgeThreatScanner = env.KNOWLEDGE_FILE_MALWARE_SCAN_MODE === 'required'
    ? new ClamAvKnowledgeFileScanner({
        host: env.CLAMAV_HOST,
        port: env.CLAMAV_PORT,
        timeoutMs: env.CLAMAV_SCAN_TIMEOUT_SECONDS * 1_000,
      })
    : null;
  const knowledgeFileService = new KnowledgeFileService({
    assets: knowledgeFileAssets,
    objects: knowledgeFileObjects,
    permissions,
    logger,
    maxBytes: env.KNOWLEDGE_FILE_MAX_MB * 1_024 * 1_024,
    stagingTtlMs: env.KNOWLEDGE_FILE_STAGING_TTL_HOURS * 60 * 60_000,
    deletionLeaseMs: env.KNOWLEDGE_FILE_DELETION_LEASE_SECONDS * 1_000,
    threatScanner: knowledgeThreatScanner,
    threatScanRequired: env.KNOWLEDGE_FILE_MALWARE_SCAN_MODE === 'required',
    threatScanTimeoutMs: env.CLAMAV_SCAN_TIMEOUT_SECONDS * 1_000,
  });
  const conversationAttachmentAssets = new ConversationAttachmentAssetService({
    assets: new PrismaConversationAttachmentAssetStore(prisma),
    objects: new CloudinaryConversationAttachmentObjectStore(cloudinaryAdapter),
    logger,
    maxBytes: env.KNOWLEDGE_FILE_MAX_MB * 1_024 * 1_024,
    threatScanner: knowledgeThreatScanner,
    threatScanRequired: env.KNOWLEDGE_FILE_MALWARE_SCAN_MODE === 'required',
    threatScanTimeoutMs: env.CLAMAV_SCAN_TIMEOUT_SECONDS * 1_000,
  });
  const conversationAttachmentSource = new ChannelAttachmentSource({
    lark: new LarkConversationAttachmentSource(
      conversationAttachments,
      new LarkFileClient(env, logger),
      logger,
    ),
    web: new WebConversationAttachmentSource(
      conversationAttachmentAssets,
      logger,
    ),
  });
  const knowledgeDocuments = new PrismaKnowledgeDocumentRepository(prisma);
  const knowledgeDocumentIndex = new KnowledgeDocumentIndexService({
    documents: knowledgeDocuments,
    objects: knowledgeFileObjects,
    parser: new DefaultKnowledgeDocumentParser({
      ocr: env.OPENROUTER_API_KEY
        ? new OpenRouterKnowledgeOcr({
            apiKey: env.OPENROUTER_API_KEY,
            model: env.VISION_OCR_MODEL,
            providerOrder: env.OPENROUTER_PROVIDER_ORDER,
          })
        : null,
      maxPages: env.KNOWLEDGE_DOCUMENT_MAX_PAGES,
      maxOcrPages: env.KNOWLEDGE_DOCUMENT_MAX_OCR_PAGES,
      maxArchiveEntries: env.KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_ENTRIES,
      maxArchiveUncompressedBytes: env.KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_UNCOMPRESSED_BYTES,
      maxArchiveCompressionRatio: env.KNOWLEDGE_DOCUMENT_MAX_ARCHIVE_COMPRESSION_RATIO,
    }),
    semantic: hindsightService,
    logger,
    maxBytes: env.KNOWLEDGE_FILE_MAX_MB * 1_024 * 1_024,
    parseTimeoutMs: env.KNOWLEDGE_DOCUMENT_PARSE_TIMEOUT_SECONDS * 1_000,
    maxConcurrency: env.KNOWLEDGE_DOCUMENT_INDEX_CONCURRENCY,
    chunking: {
      targetChars: env.KNOWLEDGE_DOCUMENT_CHUNK_TARGET_CHARS,
      maxChars: env.KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARS,
      overlapChars: env.KNOWLEDGE_DOCUMENT_CHUNK_OVERLAP_CHARS,
      maxChunks: env.KNOWLEDGE_DOCUMENT_MAX_CHUNKS,
      maxExtractedChars: env.KNOWLEDGE_DOCUMENT_MAX_EXTRACTED_CHARS,
    },
  });
  const knowledgeMutations = new KnowledgeMutationService(
    new PrismaKnowledgeMutationStore(prisma),
    new DefaultKnowledgeContentValidator(knowledgeFileAssets, {
      requireThreatScan: env.KNOWLEDGE_FILE_MALWARE_SCAN_MODE === 'required',
    }),
  );
  const knowledgeProjections = new KnowledgeProjectionService({
    prisma,
    memory: memoryService,
    documents: knowledgeDocumentIndex,
    fileAssets: knowledgeFileAssets,
    files: knowledgeFileService,
    logger,
    options: {
      batchSize: env.KNOWLEDGE_PROJECTION_BATCH_SIZE,
      maxAttempts: env.KNOWLEDGE_PROJECTION_MAX_ATTEMPTS,
      processingLeaseMs: env.KNOWLEDGE_PROJECTION_PROCESSING_LEASE_SECONDS * 1_000,
    },
  });
  const knowledgeOperations = new KnowledgeOperationsService(prisma, {
    pendingAgeWarningMs: env.KNOWLEDGE_HEALTH_PENDING_AGE_WARNING_SECONDS * 1_000,
    processingLeaseMs: env.KNOWLEDGE_PROJECTION_PROCESSING_LEASE_SECONDS * 1_000,
  }, hindsightService ? { hindsight: hindsightService } : {});
  const knowledgeResources = new KnowledgeResourceQueryService({
    prisma,
    departments: deptRepo,
  });
  const personalMemoryCommands = new PersonalMemoryCommandService({
    permissions,
    resources: knowledgeResources,
    mutations: knowledgeMutations,
    projections: knowledgeProjections,
  });
  const knowledgeRecall = new KnowledgeRecallService({
    memory: memoryService,
    departments: deptRepo,
    permissions,
    resources: knowledgeResources,
  });
  const knowledgeDocumentSearch = new KnowledgeDocumentSearchService({
    documents: knowledgeDocuments,
    semantic: hindsightService,
    departments: deptRepo,
    permissions,
  });
  const knowledgeLearningQueue = new KnowledgeLearningQueue(
    queueRedisUrl,
    env.REDIS_KNOWLEDGE_LEARNING_QUEUE_NAME,
  );
  const knowledgeLearningService = new KnowledgeLearningService({
    prisma,
    queue: knowledgeLearningQueue,
    extractor: new DeepSeekKnowledgeLearningExtractor(
      deepSeekModel(env.KNOWLEDGE_LEARNING_MODEL_ID),
      env.KNOWLEDGE_LEARNING_MODEL_ID,
    ),
    personalMemoryCommands,
    logger,
    options: {
      immediateConfidence: env.KNOWLEDGE_LEARNING_IMMEDIATE_CONFIDENCE,
      repeatedConfidence: env.KNOWLEDGE_LEARNING_REPEATED_CONFIDENCE,
      repeatedEvidenceCount: env.KNOWLEDGE_LEARNING_REPEATED_EVIDENCE_COUNT,
    },
  });

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
    resolveSheetReference: resolveGoogleSheetReference,
    beginAuthorization: beginGoogleAuthorization,
  })) {
    toolRegistry.register(tool);
  }
  toolRegistry.register(createMailAutomationsTool({
    repo: mailOpsRepo,
    runtime: {
      pubsubConfigured: Boolean(gmailPubsubConfig),
      // The worker reads this flag itself; without it here the tool could not
      // see the difference between "configured" and "will actually run".
      workersEnabled: env.DIVO_AUTONOMOUS_WORKERS_ENABLED,
    },
    resolveConnection: resolveMailAutomationGoogleConnection,
    beginAuthorization: beginGoogleAuthorization,
    authorizeLarkChat: authorizeMailOpsLarkChat,
    connectionApproval: input => connectionRateLimits.approval(input),
    // The read repository, not `mailOpsRepo`: a dry run must not be able to
    // touch a lease, a cursor, or a rule status even by accident.
    dryRun: input => mailOpsReadRepo.loadRuleForDryRun(input),
  }));
  /*
   * The web route's create path, built from exactly the dependencies the tool
   * above is given so the two cannot disagree about what a rule may be.
   *
   * They are still two paths: the tool writes through the repository directly.
   * That is why `externalForward` is configured here and not only on the gate —
   * the gate runs in the gateway executor, which the browser never reaches, so
   * without this the identical rule is governed on one surface and not the
   * other.
   */
  const writeMailRule = createMailRuleWriter({
    repo: mailOpsRepo,
    runtime: {
      pubsubConfigured: Boolean(gmailPubsubConfig),
      workersEnabled: env.DIVO_AUTONOMOUS_WORKERS_ENABLED,
    },
    resolveConnection: resolveMailAutomationGoogleConnection,
    authorizeLarkChat: authorizeMailOpsLarkChat,
    /*
     * One live call, so a rule is never created on a grant Google has already
     * ended. `googleAccessTokenFor` both discovers that and records it — it
     * clears every cache partition for the connection and marks it
     * reauthorization-required — so this probe is also what makes the Mail page
     * start saying "reconnect" instead of waiting for the eleventh watch
     * failure to say it for us.
     */
    probeConnection: async ({ companyId, userId, connectionId }) => {
      const connection = await integrationConnectionRepo.findAccessibleGoogleConnection({
        companyId,
        userId,
        connectionId,
        minimumAccess: 'read_write',
      });
      if (!connection.ok) {
        return { kind: 'unavailable', reason: connection.error.message };
      }
      if (!connection.value?.refreshToken) {
        return { kind: 'revoked' };
      }
      try {
        await googleAccessTokenFor({
          companyId,
          connectionId,
          cacheUserId: `connection:${connectionId}`,
          refreshToken: connection.value.refreshToken,
        });
        return { kind: 'alive' };
      } catch (error) {
        // Only a rejected refresh means the grant itself is dead. A timeout, a
        // 5xx, a DNS blip — those say nothing about it, and reporting them as
        // revoked would send somebody reconnecting a working account.
        if (error instanceof GoogleTokenRefreshError && error.code === 'refresh_rejected') {
          return { kind: 'revoked' };
        }
        return {
          kind: 'unavailable',
          reason: error instanceof Error
            ? `Divo could not reach Google to check this account (${error.message}).`
            : 'Divo could not reach Google to check this account.',
        };
      }
    },
    connectionApproval: input => connectionRateLimits.approval(input),
    /*
     * The same approver the agent path would ask, resolved the same way.
     *
     * Reached through a closure rather than by moving the resolver up: it is
     * only ever called while serving a request, long after this function has
     * returned, and reordering composition to satisfy a lexical position is a
     * change with far more reach than the one being made here.
     */
    externalForward: {
      resolveManager: (departmentId, companyId, options) =>
        approvalResolver.resolveManager(departmentId, companyId, options),
      get disableManagerSelfBypass() {
        return approvalGateOptions.disableManagerSelfBypass;
      },
      onSelfBypass: (bypassed) => {
        logger.info('mail_ops.external_forward_self_bypass', bypassed);
      },
      get disableCompanyAdminExemption() {
        return approvalGateOptions.disableCompanyAdminExternalForwardExemption;
      },
      onCompanyAdminExempt: (exempt) => {
        // Deliberately not the line above. That one says the approver and the
        // requester were the same person; this one says nobody was asked.
        logger.info('mail_ops.external_forward_admin_exempt', exempt);
      },
    },
  });

  // Same model the other background readers use — this is a small, strict
  // extraction, not a conversation.
  const compileMailRule = createMailRuleCompiler({
    model: deepSeekModel(env.PERSONA_LEARNING_MODEL_ID),
  });

  const judgeMailMessage = createMailRuleJudge({
    model: deepSeekModel(env.PERSONA_LEARNING_MODEL_ID),
    // Without this, a rule holding one message in five is indistinguishable
    // from one holding none: the answer that could not be read was discarded
    // and the member only ever saw a fixed sentence.
    logger: logger.child({ service: 'mail-ops-judge' }),
  });

  const composeMailBrief = createMailBriefComposer({
    model: deepSeekModel(env.PERSONA_LEARNING_MODEL_ID),
    appBaseUrl: env.APP_BASE_URL,
  });

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
    crmClient:   zohoPaginatedCrmClient,
    crmOps:      zohoCrmOps,
  }));
  toolRegistry.register(createZohoBooksTool({
    booksClient:     zohoPaginatedBooksClient,
    invoiceStaging:  new PrismaStagedInvoiceStore(prisma),
    purchaseOrderStaging: new PrismaStagedPurchaseOrderStore(prisma),
    billStaging:     new PrismaStagedBillStore(prisma),
    invoiceReviewer: createInvoiceReviewer({
      model: deepSeekModel(env.ZOHO_INVOICE_REVIEW_MODEL_ID),
      logger: logger.child({ service: 'zoho-invoice-reviewer' }),
    }),
    conversationHistory: conversationRepo,
    documentParser:  invoiceDocumentParser,
    ...(env.ZOHO_BOOKS_HOME_GST_STATE_CODE
      ? { homeGstStateCode: env.ZOHO_BOOKS_HOME_GST_STATE_CODE }
      : {}),
    financeOps:      zohoFinanceOps,
    inlineThreshold: env.ZOHO_BOOKS_CSV_INLINE_THRESHOLD,
    attachmentSource: conversationAttachmentSource,
    appBaseUrl:      env.ZOHO_BOOKS_APP_BASE_URL,
  }));
  toolRegistry.register(createWebSearchTool({ client: webSearchClientAdapter }));
  toolRegistry.register(createKnowledgeTool({
    mutations: knowledgeMutations,
    projections: knowledgeProjections,
    recall: knowledgeRecall,
    resources: knowledgeResources,
    files: knowledgeFileService,
    documents: knowledgeDocumentSearch,
  }));
  toolRegistry.register(createSemrushTool({
    service: semrushService,
    audit: auditService,
    apiKeyExhaustion: apiKeyExhaustionFacade,
  }));
  toolRegistry.register(createOmsSiteDataTool({
    service: companyOmsSiteDataService,
    audit: auditService,
  }));
  toolRegistry.register(createMenhoodDataTool({
    service: menhoodQueryService,
    audit: auditService,
  }));
  const [shopifyAnalyticsTool, shopifyOrdersTool, shopifyCustomersTool] = createShopifyTools({
    service: shopifyService,
    audit: auditService,
  });
  toolRegistry.register(shopifyAnalyticsTool);
  if (env.SHOPIFY_PROTECTED_DATA_TOOLS_ENABLED) {
    toolRegistry.register(shopifyOrdersTool);
    toolRegistry.register(shopifyCustomersTool);
  }
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
  // Every provider whose native shapes a model would otherwise have to guess.
  // Airtable earns its place here for the same reason Google did: its record
  // filter tree is not reconstructable from prose, and each wrong guess costs a
  // validation dump larger than the schema.
  const workContractBootstrap = new CompositeWorkContractBootstrap([
    new GoogleWorkspaceContractBootstrapService(getGoogleWorkspaceMcpConnection),
    new AirtableContractBootstrapService(getAirtableMcpConnection),
  ]);
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
    protectedDataRuns,
    shopifyDataRuns,
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
  const runEffectReceipts = new RunEffectReceiptStore(ephemeralCache);
  const larkPiRuntime = new (await import('./application/runtime/lark-pi-runtime.service')).LarkPiRuntimeService({
    prisma,
    logger,
    memberJwtSecret: env.MEMBER_JWT_SECRET,
    backendUrl: env.PI_LARK_BACKEND_URL ?? env.BACKEND_PUBLIC_URL,
    controllerUrl: env.PI_LARK_CONTROLLER_URL,
    instanceId: env.PI_LARK_RUNTIME_INSTANCE_ID,
    leaseTtlSeconds: env.PI_RUNTIME_LEASE_TTL_SECONDS,
    runTimeoutMs: env.PI_LARK_RUN_TIMEOUT_MS,
    runEffectReceipts,
    runLatencyRecorder,
    executionRuns: executionRunLifecycle,
    conversationHistory: conversationRepo,
    knowledgeRecall,
    runOrigins,
    ...(env.KNOWLEDGE_LEARNING_ENABLED ? { knowledgeLearning: knowledgeLearningService } : {}),
    allowedModelsFor: (userId) => llmProxyService.allowedModelsFor(userId),
    onProtectedRun: notice => auditService.recordRequired({
      actorId: notice.userId,
      companyId: notice.companyId,
      action: 'shopify.protected_run.session_deleted',
      outcome: 'success',
      metadata: {
        runId: notice.runId,
        threadId: notice.threadId,
        chatId: notice.chatId,
        sessionDeletionRequested: notice.sessionDeletionRequested,
        referenceCount: notice.references.length,
        connectionIds: [...new Set(notice.references.map(reference => reference.connectionId))],
        resourceTypes: [...new Set(notice.references.map(reference => reference.resourceType))],
      },
    }),
  });

  const larkAdapter = new LarkChannelAdapter({
    env,
    logger: logger.child({ channel: 'lark' }),
    deliveryRepo: channelDeliveryRepo,
  });
  if (!options.skipLarkInitialize) {
    await larkAdapter.initialize();
  }
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
  // Only signal a member has that their mail rules stopped. Lark-only for
  // now: the people who create mail rules today do so from Lark, so that is
  // where they will look. A no-Lark owner is recorded and skipped, not retried.
  const mailOpsNotifier = new MailOpsMailboxNotifier({
    readRepo: mailOpsReadRepo,
    repo: mailOpsRepo,
    resolveLarkOpenId: async input => {
      const identity = await channelIdentityRepo.resolveByUserId(
        input.userId,
        input.companyId,
      );
      if (!identity.ok) throw identity.error;
      return identity.value?.larkOpenId ?? null;
    },
    sendDirectCard: (openId, card) => larkAdapter.sendDirectCard(openId, card),
    logger,
  });
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
        // Also the path a revoked account now takes: once marked, it stops
        // being listed as accessible, so it arrives here rather than as a
        // refresh failure. Typed so the worker still files it as
        // `connection_unavailable` and the mailbox keeps its reconnect remedy.
        throw new MailOpsConnectionUnavailableError();
      }
      return googleAccessTokenFor({
        companyId: input.companyId,
        connectionId: input.connectionId,
        cacheUserId: `connection:${input.connectionId}`,
        refreshToken: connection.value.refreshToken,
      });
    },
    /**
     * Answers whether one rule may act, and never throws for a denial.
     *
     * It used to throw on any permission error. Inside the worker's per-rule
     * loop that throw escaped to the method-level catch, failed the sync, and
     * left the cursor unmoved — so one person changing department stalled
     * every rule on their mailbox, retrying the same range every five minutes
     * forever. Denials are answers now; only genuinely unanswerable questions
     * are reported as unavailable, and those are the ones worth retrying.
     */
    authorizeRule: async input => {
      // `minimumAccess` reads like a live control here and is not one: a
      // connection's owner is always granted `admin`, and the ownership check
      // just below means a Mail Ops rule can only ever exist on a connection
      // the requester owns. So the read_write floor cannot currently reject
      // anything. It is kept because it becomes real the moment rules are
      // allowed on shared connections — but nobody should read it as the thing
      // stopping a downgraded share from forwarding mail today. The ownership
      // and scope checks below are what actually stop that.
      const connection = await integrationConnectionRepo
        .findAccessibleGoogleConnection({
          companyId: input.companyId,
          userId: input.userId,
          connectionId: input.connectionId,
          minimumAccess: 'read_write',
        });
      if (!connection.ok) {
        return {
          verdict: 'unavailable',
          reason: connection.error.message,
        };
      }
      if (
        connection.value?.ownerType !== 'user'
        || connection.value.ownerUserId !== input.userId
        || !connection.value.refreshToken
      ) {
        return {
          verdict: 'denied',
          reason: 'The Google account behind this rule is no longer connected to you.',
        };
      }
      if (!hasGoogleScopeGroups(connection.value.scopes, [
        [GOOGLE_SCOPE.gmailModify],
        [GOOGLE_SCOPE.gmailSend],
      ])) {
        return {
          verdict: 'denied',
          reason: 'Your Google connection no longer allows Divo to read and send mail. Reconnect it to resume.',
        };
      }
      const identity = await channelIdentityRepo.resolveByUserId(
        input.userId,
        input.companyId,
      );
      if (!identity.ok) {
        return { verdict: 'unavailable', reason: identity.error.message };
      }
      if (!identity.value) {
        return {
          verdict: 'denied',
          reason: 'Divo can no longer identify you in this company.',
        };
      }
      const resolved = await permissions.resolve({
        companyId: asCompanyId(input.companyId),
        userId: asUserId(input.userId),
        companyRole: asCompanyRoleSlug(identity.value.aiRole),
        ...(input.departmentId
          ? { departmentId: asDepartmentId(input.departmentId) }
          : {}),
        channel: 'lark',
      });
      if (!resolved.ok) {
        // The one distinction that matters: a store that could not be read is
        // retried, a decision is recorded.
        if (resolved.error.payload.reason === 'permission_lookup_failed') {
          return { verdict: 'unavailable', reason: resolved.error.message };
        }
        return {
          verdict: 'denied',
          reason: input.departmentId
            ? 'This rule is tied to a team you are no longer in, so Divo will not act on it.'
            : 'Your access to mail automations was removed.',
        };
      }
      const allowed = resolved.value.allowedActionsByTool
        .get(asToolId('mailAutomations'))
        ?.has('execute') ?? false;
      return allowed
        ? { verdict: 'allowed' }
        : {
            verdict: 'denied',
            reason: 'You no longer have permission to run mail automations.',
          };
    },
    authorizeLarkChat: authorizeMailOpsLarkChat,
    connectionRateLimits,
    // The rule owner's own DM. Same adapter, same idempotency key; only the
    // receive-id type differs, because Lark takes an open id directly and a DM
    // therefore needs no chat to have been created first.
    deliverLarkDm: async input => {
      const sent = await larkAdapter.sendDmToOpenId(
        input.openId,
        input.text,
        input.idempotencyKey,
      );
      if (!sent.ok) throw sent.error;
      return sent.value;
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
    // The rule's AI step. Same model the compiler uses, and for the same
    // reason: this is one closed question with a bounded answer, not a
    // conversation, and it runs inside a delivery lane where a slow model is a
    // lane not moving anybody else's mail.
    judgeMessage: judgeMailMessage,
    // Twice on workdays, in the company's own timezone. Computed per call, so
    // the first run is the next real slot rather than whenever the process
    // happened to boot.
    briefDefaults: () => ({
      ...DEFAULT_MAIL_BRIEF_SCHEDULE,
      nextRunAt: nextMailBriefRunAt(DEFAULT_MAIL_BRIEF_SCHEDULE, new Date())
        // A schedule that cannot find a slot in fourteen days is not one this
        // constant can produce; the fallback exists so the type is honest
        // rather than because it can be reached.
        ?? new Date(Date.now() + 12 * 60 * 60_000),
    }),
    runBrief: claim => runMailBrief(claim),
    reviewMailboxHealth: subscriptionId =>
      mailOpsNotifier.review(subscriptionId),
    logger,
    mailboxLanes: env.DIVO_MAIL_OPS_MAILBOX_LANES,
    deliveryLanes: env.DIVO_MAIL_OPS_DELIVERY_LANES,
    ...(gmailPubsubConfig
      ? { pubsubTopicName: gmailPubsubConfig.topic }
      : {}),
  });
  /*
   * One member's brief, end to end.
   *
   * Defined after the worker because the worker only calls it at tick time, and
   * declared here rather than inside the worker's dependency literal so the four
   * steps it performs — read the window, compose, deliver, advance — stay
   * readable as a unit.
   */
  const runMailBrief = createMailBriefRunner({
    repo: mailOpsRepo,
    compose: composeMailBrief,
    deliverLarkDm: async input => {
      const sent = await larkAdapter.sendDmToOpenId(
        input.openId,
        input.content,
        input.idempotencyKey,
      );
      if (!sent.ok) throw sent.error;
      return sent.value;
    },
    /*
     * Where Divo sends it.
     *
     * `null` is a real answer, not a failure: a member who signed in with a
     * password and never linked Lark has nowhere for a brief to go. The runner
     * treats that as "skip this window" rather than retrying forever against an
     * identity that does not exist.
     */
    resolveLarkOpenId: async ({ userId, companyId }) => {
      const identity = await channelIdentityRepo.resolveByUserId(userId, companyId);
      if (!identity.ok) throw identity.error;
      return identity.value?.larkOpenId ?? null;
    },
    logger,
  });
  mailBriefOnboarding = createMailBriefOnboarding({
    repo: mailOpsRepo,
    wakeMailOps: () => mailOpsWorker.wake(),
    logger,
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
  const approvalGateOptions = resolveApprovalGateOptions(env);
  if (approvalGateOptions.disableManagerSelfBypass) {
    logger.warn('approval.gate.manager_self_bypass_disabled');
  }
  const approvalGate     = new ApprovalGateService(
    approvalRepo,
    approvalResolver,
    larkAdapter,
    logger.child({ service: 'approval-gate' }),
    { ...approvalGateOptions, knowledgeMutations },
    connectionRateLimits,
  );
  const gatewayToolExecutor = new ToolExecutor({
    toolRegistry,
    permissions,
    approvalGate,
    connectionRateLimits,
    connectionRegistry: integrationConnectionRepo,
    protectedDataRuns,
    shopifyDataRuns,
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
  // Delivers to a Lark open_id rather than a chat. Shared by the scheduler,
  // which has no chat to reply into, and the approval resumer, which inherits
  // that same problem when the approved action came from a scheduled run.
  const scheduledLarkDmAdapter = new ScheduledLarkDmChannelAdapter({
    client: new LarkMessagingClient({
      appId: env.LARK_APP_ID,
      appSecret: env.LARK_APP_SECRET,
      ...(env.LARK_API_BASE_URL ? { apiBaseUrl: env.LARK_API_BASE_URL } : {}),
      logger: logger.child({ service: 'scheduled-lark-dm-client' }),
    }),
    logger: logger.child({ service: 'scheduled-lark-dm-channel' }),
  });
  /*
   * The department a member is acting in, for a request that carries no run.
   *
   * The preference first, because that is what the member last chose and what
   * every runtime path already treats as their active department. Their
   * membership second: somebody who has never opened the switcher still belongs
   * somewhere, and answering "no department" for them means Divo cannot work
   * out who approves anything they ask for.
   */
  const resolveMemberDepartmentId = async (input: {
    companyId: string;
    userId: string;
  }): Promise<string | null> => {
    const preference = await prisma.userDepartmentPreference.findUnique({
      where: { companyId_userId: { companyId: input.companyId, userId: input.userId } },
      select: { activeDepartmentId: true },
    });
    if (preference?.activeDepartmentId) return preference.activeDepartmentId;

    const membership = await prisma.departmentMembership.findFirst({
      where: {
        userId: input.userId,
        status: 'active',
        department: { companyId: input.companyId, status: 'active' },
      },
      orderBy: { updatedAt: 'desc' },
      select: { departmentId: true },
    });
    return membership?.departmentId ?? null;
  };

  /**
   * May this member run mail automations at all — asked at create, not only at
   * every delivery.
   *
   * The same question `authorizeRule` asks on each message, deliberately: the
   * capability is **`execute`**, and the channel is **Lark**, because that is
   * what the worker resolves and a rule its owner may not execute is a rule
   * that exists, lists as Working, and silently stops on every message. Asking
   * anything different here would let exactly that through.
   *
   * Enforcement stays where it was. This only adds the answer at the moment
   * somebody asks the question.
   */
  const canRunMailRules = async (input: {
    companyId: string;
    userId: string;
    companyRole: string;
    departmentId?: string;
    /**
     * What the member is asking to do.
     *
     * Named rather than assumed, because the answer differs: creating a rule
     * needs `create` and background `execute`, archiving one needs `delete` and
     * no execute at all. This used to check `execute` alone for every request,
     * which both refused members who could legitimately archive and admitted
     * members who had lost the right to edit.
     */
    operation: MailRuleOperation;
  }): Promise<{ kind: 'allowed' | 'denied' | 'unavailable'; message?: string }> => {
    const resolved = await permissions.resolve({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(input.companyRole),
      ...(input.departmentId ? { departmentId: asDepartmentId(input.departmentId) } : {}),
      channel: 'lark',
    });
    if (!resolved.ok) {
      // The one distinction that matters: a store that could not be read is
      // retried, a decision is recorded. Calling an unreadable store a refusal
      // sends somebody asking for access they already have.
      return resolved.error.payload.reason === 'permission_lookup_failed'
        ? { kind: 'unavailable', message: resolved.error.message }
        : {
            kind: 'denied',
            message: 'Divo could not work out your access to mail automations.',
          };
    }
    // The same decision the agent tool makes, from the same function, so the
    // browser and Divo-in-Lark cannot answer one member two different ways.
    const verdict = mailRulePermission(
      input.operation,
      resolved.value.allowedActionsByTool.get(asToolId('mailAutomations')),
    );
    return verdict.allowed
      ? { kind: 'allowed' }
      : {
          kind: 'denied',
          message: mailRuleRefusal(input.operation, verdict.missing),
        };
  };

  /*
   * Built here rather than beside the writer because it needs the gate, and the
   * gate needs half the container. The writer refuses an external forward on
   * its own; this is what turns that refusal into a question somebody can
   * answer.
   */
  const requestMailRuleExternalApproval = createMailRuleExternalApproval({
    approvalGate,
    permissions,
    logger,
  });
  const approvalResumer  = new ApprovalResumerService({
    approvalRepo,
    larkAdapter,
    scheduledDmAdapter: scheduledLarkDmAdapter,
    channelIdentityRepo,
    approvalGate,
    toolExecutor: gatewayToolExecutor,
    permissions,
    automationPlanExecutor,
    /* The same store the web run writes its own turns through, so a resumed
       approval lands in the thread as an ordinary message. Without it a web
       approval executed correctly and reported into the void. */
    webTranscript: conversationRepo,
    logger: logger.child({ service: 'approval-resumer' }),
  });
  const approvalCardHandler = new LarkApprovalCardHandler(
    approvalRepo,
    approvalResumer,
    larkAdapter,
    logger.child({ service: 'approval-card-handler' }),
    auditService,
  );
  const workbookConversionCardHandler = new LarkWorkbookConversionCardHandler(
    new WorkbookConversionConfirmationService({
      offers: runEffectReceipts,
      queue: workbookConversionQueue,
    }),
    logger.child({ service: 'workbook-conversion-card-handler' }),
  );
  const resolveWorkbookIdentity = async (companyId: string, userId: string) => {
    const resolved = await channelIdentityRepo.resolveByUserId(userId, companyId);
    if (!resolved.ok) throw resolved.error;
    return resolved.value;
  };
  const resolveWorkbookPermission = async (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly departmentId?: string;
  }) => {
    const identity = await resolveWorkbookIdentity(input.companyId, input.userId);
    if (!identity) return null;
    const resolved = await permissions.resolve({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      ...(input.departmentId ? { departmentId: asDepartmentId(input.departmentId) } : {}),
      channel: 'lark',
    });
    if (!resolved.ok) throw resolved.error;
    return resolved.value;
  };
  const resolveWorkbookConnection = async (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly sourceConnectionId: string;
  }) => {
    const resolved = await integrationConnectionRepo.findAccessibleGoogleConnection({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: input.sourceConnectionId,
      minimumAccess: 'read_write',
    });
    if (!resolved.ok) throw resolved.error;
    const connection = resolved.value;
    if (!connection) return null;
    return {
      connectionId: connection.id,
      companyId: connection.companyId,
      ownerType: connection.ownerType,
      ...(connection.ownerUserId ? { ownerUserId: connection.ownerUserId } : {}),
      status: 'connected' as const,
      ...(connection.accountEmail ? { accountEmail: connection.accountEmail } : {}),
      scopes: connection.scopes,
    };
  };
  const workbookConversionDelivery = new WorkbookConversionLarkDelivery({
    store: new RedisWorkbookConversionLarkDeliveryStore(ephemeralCache),
    lark: larkAdapter,
    logger,
  });
  const workbookConversionCore = new GoogleDriveXlsxConversionWorker({
    checkpoints: new GoogleDriveXlsxConversionCheckpointStore(ephemeralCache),
    identity: {
      resolve: async input => {
        const identity = await resolveWorkbookIdentity(input.companyId, input.userId);
        return identity
          ? { companyId: identity.companyId, userId: identity.userId, active: true }
          : null;
      },
    },
    permissions: {
      canReadDriveXlsx: async input => {
        const permission = await resolveWorkbookPermission(input);
        return permission?.allowedActionsByTool.get(asToolId('googleDrive'))?.has('read') ?? false;
      },
      canCreateGoogleSheet: async input => {
        const permission = await resolveWorkbookPermission(input);
        return permission?.allowedActionsByTool.get(asToolId('googleSheets'))?.has('create') ?? false;
      },
    },
    connections: { resolve: resolveWorkbookConnection },
    drive: new GoogleDriveXlsxConversionAdapter(async input => {
      const connection = await integrationConnectionRepo.findAccessibleGoogleConnection({
        companyId: input.companyId,
        userId: input.userId,
        connectionId: input.connectionId,
        minimumAccess: 'read_write',
      });
      if (!connection.ok) throw connection.error;
      if (
        !connection.value?.refreshToken
        || connection.value.ownerType !== 'user'
        || connection.value.ownerUserId !== input.userId
      ) {
        throw new Error('The selected personal Google account is no longer eligible.');
      }
      const token = await googleAccessTokenFor({
        companyId: input.companyId,
        connectionId: input.connectionId,
        cacheUserId: `connection:${input.connectionId}`,
        refreshToken: connection.value.refreshToken,
      });
      await integrationConnectionRepo.touchLastUsed(input.connectionId);
      return token;
    }),
    delivery: workbookConversionDelivery,
  });
  const workbookConversionWorker = new GoogleDriveXlsxConversionConsumer({
    redisUrl: queueRedisUrl,
    core: workbookConversionCore,
    delivery: workbookConversionDelivery,
    logger,
  });

  const businessActions = new BusinessActionService({
    approvals: approvalRepo,
    toolExecutor: gatewayToolExecutor,
    logger: logger.child({ service: 'business-action' }),
  });

  // Every question Divo puts to a person, whichever surface it lands on.
  // `onResolvedCard` is what stops a delivered card from still offering buttons
  // for a decision that was already answered somewhere else.
  const decisions = new DecisionService({
    approvals: approvalRepo,
    resumer: approvalResumer,
    businessActions,
    logger: logger.child({ service: 'decision' }),
    audit: auditService,
    courier: new LarkDecisionCourier(larkAdapter, logger, env.APP_BASE_URL),
    /* Which card is drawn over the settled one. A decision opened through this
       module carries what was actually answered, and the approval resolution
       card has no field for it — it can only say approved or rejected. */
    onResolvedCard: async ({ messageId, verdict, byName, title, summary, native }) => {
      const card = native
        ? buildDecisionResolvedCard({ title, verdict, summary, byName, at: new Date() })
        : buildApprovalResolutionCard(verdict, byName, new Date());
      await larkAdapter.updateMessageById(messageId, card);
    },
  });
  const decisionCardHandler = new LarkDecisionCardHandler(decisions, logger, env.APP_BASE_URL);
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
  const knowledgeReviewDecisionQueue = new KnowledgeReviewDecisionQueue(queueRedisUrl);
  const larkKnowledgeReviewService = new LarkKnowledgeReviewService(
    ephemeralCache,
    larkAdapter,
    larkRuntimeToolExecutor,
    permissions,
    approvalGate,
    knowledgeMutations,
    logger,
    knowledgeReviewDecisionQueue,
    Boolean(env.LARK_CARD_CALLBACK_URL),
    channelIdentityRepo,
  );
  const gatewayDispatcher = new GatewayDispatcher({
    permissions,
    toolRegistry,
    skillCatalog,
    toolExecutor: gatewayToolExecutor,
    businessActions,
    connectionRegistry: integrationConnectionRepo,
    workContractBootstrap,
    mediaOcr,
    managerPersonaRuntime: managerPersonaRuntimeService,
    workResolution,
    managerTeachService,
    automationPlanService,
    skillAccessEnforcement,
    auditService,
    larkKnowledgeReview: larkKnowledgeReviewService,
    knowledgeMutations,
    personalMemoryCommands,
    resolveGoogleSheetReference,
    runEffectReceipts,
    logger: logger.child({ service: 'gateway-dispatcher' }),
  });

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
    siteIcons,
    ephemeralCache,
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
    runtimeContextLifecycle,
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
    mailOpsReadRepo,
    writeMailRule,
    requestMailRuleExternalApproval,
    resolveMemberDepartmentId,
    canRunMailRules,
    compileMailRule,
    mailBriefOnboarding,
    mailOpsWorker,
    canvaMcpOAuthService,
    airtableMcpOAuthService,
    aitableKeyVerifier,
    integrationConnectionRepo,
    shopifyAuthorizationService,
    companySerperConnectionRepo,
    companySerperService,
    semrushService,
    menhoodQueryService,
    companyOmsConnectionRepo,
    companyOmsSiteDataService,
    zohoConnectionRepo,
    zohoTokenService,
    // Observability
    executionRepo,
    executionQueryService,
    runLatencyRecorder,
    executionRunLifecycle,
    auditService,
    tokenUsageService,
  proxyKeyStore,
  llmProxyService,
  apiKeyExhaustionNotifier: apiKeyExhaustionFacade,
  // HITL approval
  approvalGate,
    approvalCardHandler,
    workbookConversionCardHandler,
    approvalResumer,
    decisions,
    decisionCardHandler,
    businessActions,
    // Workbook conversion and async ingress
    workbookConversionQueue,
    workbookConversionWorker,
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
    // Central knowledge authority
    memoryService,
    knowledgeMutations,
    knowledgeProjections,
    knowledgeOperations,
    knowledgeRecall,
    knowledgeResources,
    knowledgeLearningQueue,
    knowledgeLearningService,
    knowledgeFileService,
    knowledgeDocumentSearch,
    larkKnowledgeReviewService,
    knowledgeReviewDecisionQueue,
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
    conversationAttachments,
    conversationAttachmentAssets,
    // Pi/Desktop capability gateway
    gatewayDispatcher,
    // Container runtime, shared by the Lark webhook and the scheduler.
    larkPiRuntime,
    webRuns: new (await import('./application/runtime/web-run.service')).WebRunService({
      piRuntime: larkPiRuntime,
      identity: channelIdentityRepo,
      departments: deptRepo,
      transcript: conversationRepo,
      ...(conversationVideo ? { videos: conversationVideo } : {}),
      logger: logger.child({ service: 'web-run' }),
    }),
    conversationVideo,
    webRunRegistry: new (await import('./application/runtime/web-run-registry')).WebRunRegistry({
      logger: logger.child({ service: 'web-run-registry' }),
    }),
    webThreads: new (await import('./infrastructure/persistence/web-thread.repository')).WebThreadRepository(prisma),
    artifacts: new (await import('./infrastructure/persistence/artifact.repository')).ArtifactRepository(prisma),
    /*
      The member's own Lark account, resolved from the connection they
      authorized rather than from a run context. `userExternalId` is an open_id
      on Lark and a Divo user id on the web, so anything that reads it and asks
      Lark about it gets nothing on the web and calls that an empty list.
      The connection is the one place that always holds a real open_id.
    */
    openTasks: {
      accounts: {
        async openIdFor({ userId }) {
          const connection = await prisma.integrationConnection.findFirst({
            where: { ownerUserId: userId, provider: 'lark', status: 'connected', revokedAt: null },
            select: { externalAccountId: true },
            orderBy: { updatedAt: 'desc' },
          });
          return connection?.externalAccountId ?? null;
        },
      },
      tokens: larkUserTokenResolver,
      createClient: (userToken: string) => new LarkTaskClient({
        appId: env.LARK_APP_ID,
        appSecret: env.LARK_APP_SECRET,
        apiBaseUrl: env.LARK_API_BASE_URL,
        userToken,
      }),
    },
    // Scheduled workflow executor
    scheduledWorkflowService: new (await import('./application/scheduling/scheduled-workflow.service')).ScheduledWorkflowService({
      prisma,
      piRuntime: larkPiRuntime,
      runTimeoutMs: env.PI_LARK_RUN_TIMEOUT_MS,
      channelAdapters: { larkDm: scheduledLarkDmAdapter },
      channelIdentityRepo,
      logger: logger.child({ service: 'scheduled-workflow' }),
      clock:  systemClock,
      pollIntervalMs: env.SCHEDULED_WORKFLOW_POLL_INTERVAL_MS,
    }),
  };
}
