import { z } from 'zod';
import { TOOL_FAMILY_IDS } from '../../domain/tools/tool-id';
import { CONNECTION_PROVIDER_IDS } from '../../domain/connections/connection-provider';

export const GATEWAY_OPS = [
  'capabilities.get',
  'tools.list',
  'skills.list',
  'skills.search',
  'skills.get',
  'work.resolve',
  'persona.resolve',
  'teach.context.get',
  'teach.learning.apply',
  'connections.list',
  'media.image_ocr',
  'memory.personal.mutate',
  'knowledge.review.open',
  'knowledge.review.decide',
  'tools.preflight',
  'tools.prepare',
  'tools.commit',
  'tools.invoke',
  'automation.plan.create',
  'automation.plan.status',
] as const;

export type GatewayOp = typeof GATEWAY_OPS[number];

export const GATEWAY_STATUSES = [
  'success',
  'bad_request',
  'unauthorized',
  'unknown_op',
  'unknown_tool',
  'invalid_args',
  'permission_denied',
  'local_approval_required',
  'approval_intent_not_found',
  'approval_intent_expired',
  'approval_intent_consumed',
  'approval_intent_busy',
  'approval_required',
  'approval_rejected',
  'approval_execution_failed',
  'approval_misconfigured',
  'rate_limited',
  'rate_limit_unavailable',
  'automation_plan_not_found',
  'tool_error',
] as const;

export type GatewayStatus = typeof GATEWAY_STATUSES[number];

/**
 * Runtime-provided provenance for one Pi tool action. It is useful for
 * routing, idempotency, and audit records, but never grants identity or
 * permission: those continue to come exclusively from the member session.
 * Backend-issued runtime leases additionally bind this context to one thread.
 */
export const gatewayExecutionContextSchema = z.object({
  version: z.literal(1),
  threadId: z.string().trim().min(1).max(200),
  runId: z.string().trim().min(1).max(200),
  actionId: z.string().trim().min(1).max(256),
}).strict();

export type GatewayExecutionContext = z.infer<typeof gatewayExecutionContextSchema>;

export const gatewayRequestSchema = z.object({
  op: z.string().min(1),
  departmentId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  execution: gatewayExecutionContextSchema.optional(),
}).strict();

export type GatewayRequest = z.infer<typeof gatewayRequestSchema>;

export const toolInvocationPayloadSchema = z.object({
  toolId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
}).strict();

export const toolsInvokePayloadSchema = toolInvocationPayloadSchema.extend({
  skillId: z.string().min(1).optional(),
});

export type ToolsInvokePayload = z.infer<typeof toolsInvokePayloadSchema>;

export const personalMemoryCommandPayloadSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    subject: z.string().trim().min(1).max(500),
    logicalKey: z.string().trim().min(1).max(240),
    facts: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  }).strict(),
  z.object({
    action: z.literal('delete'),
    subject: z.string().trim().min(1).max(500),
    logicalKey: z.string().trim().min(1).max(240),
  }).strict(),
]);

export type PersonalMemoryCommandPayload = z.infer<typeof personalMemoryCommandPayloadSchema>;

const memoryKnowledgeReviewOpenPayloadSchema = z.object({
  skillId: z.string().trim().min(1).max(200),
  requestId: z.string().trim().min(1).max(120),
  kind: z.literal('memory'),
  bullets: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  requestedScope: z.enum(['department', 'company']).optional(),
}).strict();

const resourceKnowledgeReviewOpenPayloadSchema = z.object({
  skillId: z.string().trim().min(1).max(200),
  requestId: z.string().trim().min(1).max(120),
  kind: z.enum(['skill', 'file']),
  action: z.enum(['create', 'update', 'publish', 'delete']),
  scope: z.enum(['personal', 'department', 'company']),
  logicalKey: z.string().trim().min(1).max(240),
  baseVersion: z.number().int().positive().optional(),
  content: z.unknown().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'create' && value.baseVersion !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseVersion'], message: 'Create must not include baseVersion.' });
  }
  if (value.action !== 'create' && value.action !== 'publish' && value.baseVersion === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseVersion'], message: `${value.action} requires baseVersion.` });
  }
  if (value.action === 'delete' && value.content !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Delete must not include content.' });
  }
  if (value.action !== 'delete' && value.content === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: `${value.action} requires content.` });
  }
  if (value.content !== undefined) {
    try {
      const encoded = JSON.stringify(value.content);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 250_000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Content exceeds 250 KB.' });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Content must be JSON.' });
    }
  }
});

export const knowledgeReviewOpenPayloadSchema = z.union([
  memoryKnowledgeReviewOpenPayloadSchema,
  resourceKnowledgeReviewOpenPayloadSchema,
]);

export const knowledgeReviewDecisionPayloadSchema = z.object({
  mutationId: z.string().uuid(),
  contentHash: z.string().length(64).nullable(),
  decision: z.enum(['approve', 'cancel']),
}).strict();

/**
 * Validates a set of proposed calls without executing tool code, creating an
 * approval intent, or querying connection eligibility. Each invocation is
 * checked independently so the agent can repair only the rejected entries.
 */
export const toolsPreflightPayloadSchema = z.object({
  invocations: z.array(toolInvocationPayloadSchema).min(1).max(20),
}).strict();

export type ToolsPreflightPayload = z.infer<typeof toolsPreflightPayloadSchema>;

/**
 * An immutable, manager-approved batch of gateway mutations. The desktop
 * runtime can prepare this after it has finished any local/Python transforms;
 * it never carries a bearer token, SaaS credential, or executable code.
 */
export const automationPlanCreatePayloadSchema = z.object({
  title: z.string().trim().min(3).max(140),
  summary: z.string().trim().min(3).max(2_000),
  invocations: z.array(toolsInvokePayloadSchema).min(1).max(100),
}).strict();

export type AutomationPlanCreatePayload = z.infer<typeof automationPlanCreatePayloadSchema>;

export const automationPlanStatusPayloadSchema = z.object({
  planId: z.string().uuid(),
}).strict();

export type AutomationPlanStatusPayload = z.infer<typeof automationPlanStatusPayloadSchema>;

export const toolsCommitPayloadSchema = z.object({
  intentId: z.string().uuid(),
}).strict();

export type ToolsCommitPayload = z.infer<typeof toolsCommitPayloadSchema>;

export const skillsGetPayloadSchema = z.object({
  skillId: z.string().min(1),
}).strict();

export const skillsSearchPayloadSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(5).optional(),
  context: z.record(z.unknown()).optional(),
}).strict();

/**
 * Resolves one user request against both the current department persona and
 * the RBAC-filtered company skill registry. The exact request is always
 * searched; callers may add at most two intent-preserving variants so a
 * multi-part request can surface complementary execution and presentation
 * skills without turning the search into an unbounded agent loop.
 */
export const workResolvePayloadSchema = z.object({
  query: z.string().trim().min(3).max(2_000),
  variants: z.array(z.string().trim().min(3).max(2_000)).max(2).optional(),
  limit: z.number().int().min(1).max(5).optional(),
}).strict();

/** Reads advisory, already-promoted manager persona rules for one task. */
export const personaResolvePayloadSchema = z.object({
  query: z.string().trim().min(3).max(2_000),
  limit: z.number().int().min(1).max(5).optional(),
}).strict();

export const teachContextGetPayloadSchema = z.object({
  teachSessionId: z.string().uuid(),
}).strict();

export const connectionsListPayloadSchema = z.object({
  provider: z.enum(CONNECTION_PROVIDER_IDS),
}).strict();

export const toolsListPayloadSchema = z.object({
  toolId: z.string().min(1).optional(),
  family: z.enum(TOOL_FAMILY_IDS).optional(),
}).strict().refine(
  value => !(value.toolId && value.family),
  { message: 'Use either toolId or family, not both.' },
);

export interface GatewayErrorBody {
  readonly code: GatewayStatus;
  readonly message: string;
}

export interface GatewayApprovalBody {
  readonly approvalId: string;
  readonly message: string;
  readonly status: 'pending' | 'rejected' | 'failed';
  readonly authority: 'connection_owner' | 'company_admin' | 'department_manager';
  readonly approverName: string;
  readonly scope: 'once';
  readonly requestState: 'dispatching' | 'created' | 'reused' | 'replaced_expired';
  readonly nextAction: 'wait' | 'change_request';
  readonly retry: 'retry_exact' | 'change_request';
}

export interface GatewayResponse<T = unknown> {
  readonly ok: boolean;
  readonly status: GatewayStatus;
  readonly data?: T;
  readonly error?: GatewayErrorBody;
  readonly approval?: GatewayApprovalBody;
}

export interface GatewayMemberContext {
  readonly companyId: string;
  readonly userId: string;
  readonly aiRole: string;
  readonly channel?: 'desktop' | 'lark';
  readonly email: string | null;
  readonly larkOpenId: string | null;
  readonly larkTenantKey?: string | null;
  readonly runtimeChatId?: string;
  readonly runtimeRunId?: string;
  readonly runtimeThreadId?: string;
  readonly sessionId: string;
  /**
   * How the session was issued. `scheduled_workflow` marks a machine-issued
   * session for a scheduled run, whose result the runtime delivers to the
   * creator's own DM — so nothing that run calls may deliver it anywhere else.
   */
  readonly authProvider?: string | null;
}

export function isGatewayOp(value: string): value is GatewayOp {
  return (GATEWAY_OPS as readonly string[]).includes(value);
}

export function gatewaySuccess<T>(data: T): GatewayResponse<T> {
  return { ok: true, status: 'success', data };
}

export function gatewayFailure(
  status: GatewayStatus,
  message: string,
  extra?: { approval?: GatewayApprovalBody },
): GatewayResponse {
  return {
    ok: false,
    status,
    error: { code: status, message },
    ...(extra?.approval ? { approval: extra.approval } : {}),
  };
}

/**
 * A write invocation was valid and authorized, but execution is intentionally
 * paused at the desktop approval boundary. The data contains the server-bound
 * intent and its safe presentation; it is not a successful tool execution.
 */
export function gatewayLocalApprovalRequired<T>(data: T): GatewayResponse<T> {
  return {
    ok: false,
    status: 'local_approval_required',
    data,
    error: {
      code: 'local_approval_required',
      message: 'This exact action requires local approval before execution.',
    },
  };
}
