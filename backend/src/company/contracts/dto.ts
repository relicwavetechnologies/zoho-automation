import type {
  AgentResultStatus,
  ErrorType,
  HitlActionStatus,
  OrchestrationTaskStatus,
} from './status';
import type { ToolActionGroup } from '../tools/tool-action-groups';

/** Shared file reference type — carried in normalized messages and used by buildVisionContent. */
export type NormalizedAttachedFile = {
  fileAssetId: string;
  cloudinaryUrl: string;
  mimeType: string;
  fileName: string;
};

export type NormalizedIncomingMessageDTO = {
  channel: 'lark' | 'slack' | 'whatsapp';
  userId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  messageId: string;
  timestamp: string;
  text: string;
  rawEvent: unknown;
  /** Files that were attached to this incoming message (images, docs etc). */
  attachedFiles?: NormalizedAttachedFile[];
  trace?: {
    requestId?: string;
    eventId?: string;
    textHash?: string;
    receivedAt?: string;
    larkTenantKey?: string;
    larkOpenId?: string;
    larkUserId?: string;
    channelTenantId?: string;
    companyId?: string;
    channelIdentityId?: string;
    /** Internal User.id if this Lark sender has linked their account via LarkUserAuthLink. */
    linkedUserId?: string;
    userRole?: string;
    requesterEmail?: string;
    /** Runtime-owned progress/status message id for channel UIs that support in-place updates. */
    statusMessageId?: string;
  };
};

export type OrchestrationTaskDTO = {
  taskId: string;
  messageId: string;
  userId: string;
  chatId: string;
  status: OrchestrationTaskStatus;
  complexityLevel?: 1 | 2 | 3 | 4 | 5;
  orchestratorModel?: string;
  plan: string[];
  executionMode?: 'sequential' | 'parallel' | 'mixed';
};

export type AgentInvokeInputDTO = {
  taskId: string;
  agentKey: string;
  objective: string;
  constraints?: string[];
  contextPacket: Record<string, unknown>;
  correlationId: string;
};

export type ErrorDTO = {
  type: ErrorType;
  classifiedReason: string;
  rawMessage?: string;
  retriable: boolean;
};

export type AgentResultDTO = {
  taskId: string;
  agentKey: string;
  status: AgentResultStatus;
  message: string;
  result?: Record<string, unknown>;
  error?: ErrorDTO;
  metrics?: {
    latencyMs?: number;
    tokensUsed?: number;
    apiCalls?: number;
  };
};

export type HITLActionDTO = {
  taskId: string;
  actionId: string;
  actionType: 'write' | 'update' | 'delete' | 'execute';
  summary: string;
  toolId?: string;
  actionGroup?: ToolActionGroup;
  channel?: 'desktop' | 'lark';
  subject?: string;
  requestedAt: string;
  expiresAt: string;
  status: HitlActionStatus;
};

export type CheckpointDTO = {
  taskId: string;
  version: number;
  node: string;
  state: Record<string, unknown>;
  updatedAt: string;
};

export type ZohoConnectionDTO = {
  companyId: string;
  status: 'PENDING' | 'CONNECTED' | 'FAILED' | 'DISCONNECTED';
  connectedAt: string;
  scopes: string[];
  lastSyncAt?: string;
  providerMode?: 'rest' | 'mcp';
  providerHealth?: 'healthy' | 'degraded' | 'failed';
  capabilities?: string[];
  tokenHealth?: {
    status: 'healthy' | 'expiring' | 'expired' | 'failed' | 'unknown';
    accessTokenExpiresAt?: string;
    lastRefreshAt?: string;
    failureCode?: string;
  };
};

export type IngestionJobDTO = {
  jobId: string;
  companyId: string;
  source: 'zoho';
  mode: 'historical_full' | 'delta';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progressPercent: number;
  checkpoint?: string;
  startedAt?: string;
  completedAt?: string;
};

export type VectorUpsertDTO = {
  companyId: string;
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_account' | 'zoho_deal' | 'zoho_ticket' | 'chat_turn' | 'file_document';
  sourceId: string;
  chunkIndex: number;
  contentHash: string;
  visibility?: 'personal' | 'shared' | 'public';
  ownerUserId?: string;
  conversationKey?: string;
  relationEmails?: string[];
  fileAssetId?: string;
  allowedRoles?: string[];
  payload: Record<string, unknown>;
};

export type DeltaSyncEventDTO = {
  source: 'zoho';
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_account' | 'zoho_deal' | 'zoho_ticket';
  sourceId: string;
  changedAt: string;
  companyId: string;
  operation: 'create' | 'update' | 'delete';
  eventKey: string;
  payload?: Record<string, unknown>;
};

export type AdminSessionDTO = {
  userId: string;
  companyId?: string;
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'DEPARTMENT_MANAGER';
  sessionId: string;
  expiresAt: string;
};

export type SuperAdminBootstrapDTO = {
  email: string;
  password: string;
  name?: string;
};

export type AdminNavItemDTO = {
  id: string;
  label: string;
  path: string;
  roles: Array<'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'DEPARTMENT_MANAGER'>;
};

export type ExecutionChannel = 'desktop' | 'lark';
export type ExecutionMode = 'fast' | 'high' | null;
export type ExecutionRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ExecutionPhase = 'request' | 'planning' | 'tool' | 'synthesis' | 'delivery' | 'error' | 'control';
export type ExecutionActorType = 'system' | 'planner' | 'agent' | 'tool' | 'model' | 'delivery';

export type ExecutionRunListItemDTO = {
  id: string;
  companyId: string;
  companyName: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  channel: ExecutionChannel;
  entrypoint: string;
  requestId: string | null;
  taskId: string | null;
  threadId: string | null;
  chatId: string | null;
  messageId: string | null;
  mode: ExecutionMode;
  agentTarget: string | null;
  status: ExecutionRunStatus;
  latestSummary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  eventCount: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

export type ExecutionRunDetailDTO = ExecutionRunListItemDTO;

export type ExecutionEventItemDTO = {
  id: string;
  executionId: string;
  sequence: number;
  phase: ExecutionPhase;
  eventType: string;
  actorType: ExecutionActorType;
  actorKey: string | null;
  title: string;
  summary: string | null;
  status: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type ExecutionRunFiltersDTO = {
  query?: string;
  userId?: string;
  companyId?: string;
  channel?: ExecutionChannel;
  mode?: Exclude<ExecutionMode, null>;
  status?: ExecutionRunStatus;
  dateFrom?: string;
  dateTo?: string;
  phase?: ExecutionPhase;
  actorType?: ExecutionActorType;
  page: number;
  pageSize: number;
};
