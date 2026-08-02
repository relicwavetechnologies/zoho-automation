import type { ToolActionGroup } from '../domain/permissions/tool-action-group';

export type AppError =
  | PermissionError
  | ToolError
  | ChannelError
  | OrchestrationError
  | InfraError;

// ─── Permission ────────────────────────────────────────────────────────────

export type PermissionDeniedReason =
  | 'not_allowed'
  | 'unknown_role'
  | 'unknown_tool'
  | 'department_ceiling_exceeded'
  | 'department_access_denied'
  /**
   * The permission question could not be answered — a store was unreachable,
   * not a decision that access is absent.
   *
   * Separated from `department_access_denied` because callers act on the
   * difference: a denial is durable and should be recorded and explained to a
   * person, while a lookup failure should be retried. Conflating them turned a
   * transient database blip into a permanent-looking refusal.
   */
  | 'permission_lookup_failed';

export class PermissionError extends Error {
  readonly kind = 'permission' as const;
  constructor(
    readonly payload: {
      toolId?: string;
      action?: ToolActionGroup;
      reason: PermissionDeniedReason;
      message?: string;
    },
  ) {
    super(payload.message ?? `Permission denied: ${payload.reason} (tool=${payload.toolId ?? '?'} action=${payload.action ?? '?'})`);
    this.name = 'PermissionError';
  }
}

// ─── Tool ──────────────────────────────────────────────────────────────────

export type ToolFailureReason =
  | 'bad_args'
  | 'upstream_failure'
  | 'timeout'
  | 'partial'
  | 'retryable'
  | 'unrecoverable'
  | 'permission_denied';

export class ToolError extends Error {
  readonly kind = 'tool' as const;
  constructor(
    readonly payload: {
      toolId: string;
      reason: ToolFailureReason;
      cause?: unknown;
      message?: string;
    },
  ) {
    super(payload.message ?? `Tool ${payload.toolId} failed: ${payload.reason}`);
    this.name = 'ToolError';
    if (payload.cause instanceof Error) this.cause = payload.cause;
  }
}

// ─── Channel ───────────────────────────────────────────────────────────────

export type ChannelStage =
  | 'parse_incoming'
  | 'send_status'
  | 'edit_status'
  | 'send_final'
  | 'auth';

export type ChannelFailureReason =
  | 'malformed'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'ambiguous_delivery'
  | 'partial_delivery'
  | 'timeout'
  | 'not_supported'
  | 'rate_limited';

export class ChannelError extends Error {
  readonly kind = 'channel' as const;
  constructor(
    readonly payload: {
      channel: string;
      stage: ChannelStage;
      reason: ChannelFailureReason;
      cause?: unknown;
      message?: string;
    },
  ) {
    super(payload.message ?? `Channel ${payload.channel} error at ${payload.stage}: ${payload.reason}`);
    this.name = 'ChannelError';
    if (payload.cause instanceof Error) this.cause = payload.cause;
  }
}

// ─── Orchestration ─────────────────────────────────────────────────────────

export type OrchestrationStage = 'plan' | 'execute' | 'synthesize' | 'history' | 'compose';

export type OrchestrationFailureReason =
  | 'llm_invalid_output'
  | 'dependency_cycle'
  | 'budget_exceeded'
  | 'canceled'
  | 'step_failed'
  | 'no_tools_available'
  | 'no_specialist';

export class OrchestrationError extends Error {
  readonly kind = 'orchestration' as const;
  constructor(
    readonly payload: {
      stage: OrchestrationStage;
      reason: OrchestrationFailureReason;
      cause?: unknown;
      message?: string;
    },
  ) {
    super(payload.message ?? `Orchestration failed at ${payload.stage}: ${payload.reason}`);
    this.name = 'OrchestrationError';
    if (payload.cause instanceof Error) this.cause = payload.cause;
  }
}

// ─── Infra ─────────────────────────────────────────────────────────────────

export type InfraLayer = 'prisma' | 'redis' | 'http' | 'ai' | 'filesystem';

export class InfraError extends Error {
  readonly kind = 'infra' as const;
  constructor(
    readonly payload: {
      layer: InfraLayer;
      op: string;
      cause: unknown;
      message?: string;
    },
  ) {
    super(payload.message ?? `Infra error in ${payload.layer}.${payload.op}`);
    this.name = 'InfraError';
    if (payload.cause instanceof Error) this.cause = payload.cause;
  }
}

/** Build an InfraError from a caught unknown. */
export const wrapInfra = (layer: InfraLayer, op: string, cause: unknown): InfraError =>
  new InfraError({ layer, op, cause, message: cause instanceof Error ? cause.message : String(cause) });
