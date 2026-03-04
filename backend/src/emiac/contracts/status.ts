export const ORCHESTRATION_TASK_STATUSES = [
  'pending',
  'running',
  'hitl',
  'done',
  'failed',
  'cancelled',
] as const;

export type OrchestrationTaskStatus = (typeof ORCHESTRATION_TASK_STATUSES)[number];

export const AGENT_RESULT_STATUSES = [
  'success',
  'failed',
  'needs_context',
  'hitl_paused',
  'timed_out_partial',
] as const;

export type AgentResultStatus = (typeof AGENT_RESULT_STATUSES)[number];

export const HITL_ACTION_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'expired',
] as const;

export type HitlActionStatus = (typeof HITL_ACTION_STATUSES)[number];

export const ERROR_TYPES = [
  'API_ERROR',
  'MODEL_ERROR',
  'TOOL_ERROR',
  'SECURITY_ERROR',
  'UNKNOWN_ERROR',
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];
