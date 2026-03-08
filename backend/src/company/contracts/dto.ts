import type {
  AgentResultStatus,
  ErrorType,
  HitlActionStatus,
  OrchestrationTaskStatus,
} from './status';

export type NormalizedIncomingMessageDTO = {
  channel: 'lark' | 'slack' | 'whatsapp';
  userId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  messageId: string;
  timestamp: string;
  text: string;
  rawEvent: unknown;
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
    userRole?: string;
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
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket' | 'chat_turn';
  sourceId: string;
  chunkIndex: number;
  contentHash: string;
  visibility?: 'personal' | 'shared' | 'public';
  ownerUserId?: string;
  conversationKey?: string;
  payload: Record<string, unknown>;
};

export type DeltaSyncEventDTO = {
  source: 'zoho';
  sourceType: 'zoho_lead' | 'zoho_contact' | 'zoho_deal' | 'zoho_ticket';
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
  role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
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
  roles: Array<'SUPER_ADMIN' | 'COMPANY_ADMIN'>;
};
