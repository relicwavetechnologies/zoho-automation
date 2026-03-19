import type { ToolActionGroup } from '../../tools/tool-action-groups';

export type RuntimeChannel = 'desktop' | 'lark';
export type RuntimeEngineMode = 'primary' | 'shadow';
export type RuntimeConversationStatus = 'active' | 'waiting_for_approval' | 'completed' | 'failed';
export type RuntimeRunStatus = 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
export type RuntimeApprovalStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed';
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
};

export type RuntimePermissions = {
  allowedToolIds: string[];
  allowedActionsByTool: Record<string, ToolActionGroup[]>;
  blockedToolIds: string[];
};

