import type { ToolActionGroup } from '../../tools/tool-action-groups';

export type RuntimeChannel = 'desktop' | 'lark';
export type RuntimeEngineMode = 'primary' | 'shadow';
export type RuntimeConversationStatus = 'active' | 'waiting_for_approval' | 'completed' | 'failed';
export type RuntimeRunStatus = 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
export type RuntimeApprovalStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed';
export type RuntimeComplexity = 'simple' | 'multi_step';
export type RuntimeFreshnessNeed = 'none' | 'maybe' | 'required';
export type RuntimeRiskLevel = 'low' | 'medium' | 'high';
export type RuntimeRetrievalMode = 'none' | 'vector' | 'web' | 'both';
export type RuntimeMessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'status';
export type RuntimeMessageKind =
  | 'chat'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'approval_request'
  | 'approval_resolution';
export type RuntimeRunEntrypoint =
  | 'desktop_send'
  | 'desktop_act'
  | 'lark_message'
  | 'resume_after_approval';
export type RuntimeStopReason =
  | 'completed'
  | 'needs_approval'
  | 'blocked_by_permissions'
  | 'loop_guard_triggered'
  | 'tool_validation_failure'
  | 'tool_execution_failure'
  | 'delivery_failure'
  | 'manual_stop';

export type RuntimeModelMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type RuntimeActor = {
  userId?: string;
  linkedUserId?: string;
  requesterEmail?: string;
  aiRole?: string;
  larkUserId?: string;
  larkOpenId?: string;
  larkTenantKey?: string;
};

export type GraphRunInput = {
  channel: RuntimeChannel;
  entrypoint: RuntimeRunEntrypoint;
  companyId: string;
  conversationKey: string;
  threadId?: string;
  chatId?: string;
  actor: RuntimeActor;
  message: {
    text: string;
    sourceMessageId?: string;
    attachments: Array<Record<string, unknown>>;
  };
  trace?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type RuntimeMessageRecord = {
  id: string;
  role: RuntimeMessageRole;
  messageKind: RuntimeMessageKind;
  content: string;
  createdAt: string;
  runId?: string;
  dedupeKey?: string;
};

export type RuntimeConversationRefs = {
  latestLarkDoc?: Record<string, unknown>;
  latestLarkCalendarEvent?: Record<string, unknown>;
  latestLarkTask?: Record<string, unknown>;
  recentFiles?: Array<Record<string, unknown>>;
};

export type RuntimeDiagnostics = {
  repeatedToolCallCount: Record<string, number>;
  repeatedValidationFailureCount: Record<string, number>;
  repeatedPlanHashCount: Record<string, number>;
  repeatedDeliveryKeyCount: Record<string, number>;
  nodeTransitionCount?: Record<string, number>;
  retrievalRouteCount?: Record<string, number>;
};

export type RuntimePermissions = {
  allowedToolIds: string[];
  allowedActionsByTool: Record<string, ToolActionGroup[]>;
  blockedToolIds: string[];
};

export type RuntimeClassificationResult = {
  intent: string;
  complexity: RuntimeComplexity;
  freshnessNeed: RuntimeFreshnessNeed;
  risk: RuntimeRiskLevel;
  domains: string[];
  source: 'model' | 'heuristic_fallback';
  fallbackReasonCode?: string;
};

export type RuntimeRetrievalDecision = {
  mode: RuntimeRetrievalMode;
  rationale: string;
  source: 'policy' | 'model' | 'heuristic_fallback';
};

export type RuntimeEvidenceItem = {
  kind: 'citation' | 'tool_result' | 'summary';
  toolName?: string;
  title?: string;
  summary: string;
  url?: string;
  sourceType?: string;
  sourceId?: string;
  fileAssetId?: string;
  chunkIndex?: number;
  score?: number;
  payload?: Record<string, unknown>;
};

export type RuntimeExecutionStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'approval_required'
  | 'delegated';

export type RuntimeExecutionStepState = {
  id: string;
  toolName: string;
  actionGroup: ToolActionGroup | 'read';
  status: RuntimeExecutionStepStatus;
  summary?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  citations?: Array<Record<string, unknown>>;
};

export type RuntimeDeliveryEnvelope = {
  channel: RuntimeChannel;
  payloadType: 'status' | 'approval' | 'final';
  text: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeParityReport = {
  baselineEngine: 'vercel';
  candidateEngine: 'langgraph';
  diffSummary?: string;
  metrics?: Record<string, unknown>;
};
