import { z } from 'zod';

export const GATEWAY_OPS = [
  'capabilities.get',
  'tools.list',
  'skills.list',
  'skills.search',
  'skills.get',
  'connections.list',
  'media.image_ocr',
  'tools.prepare',
  'tools.commit',
  'tools.invoke',
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
  'approval_misconfigured',
  'tool_error',
] as const;

export type GatewayStatus = typeof GATEWAY_STATUSES[number];

export const gatewayRequestSchema = z.object({
  op: z.string().min(1),
  departmentId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
}).strict();

export type GatewayRequest = z.infer<typeof gatewayRequestSchema>;

export const toolsInvokePayloadSchema = z.object({
  toolId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
}).strict();

export type ToolsInvokePayload = z.infer<typeof toolsInvokePayloadSchema>;

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

export const connectionsListPayloadSchema = z.object({
  provider: z.enum(['google_workspace', 'zoho', 'canva', 'lark']).optional(),
}).strict();

export const toolsListPayloadSchema = z.object({
  toolId: z.string().min(1).optional(),
}).strict();

export interface GatewayErrorBody {
  readonly code: GatewayStatus;
  readonly message: string;
}

export interface GatewayApprovalBody {
  readonly approvalId: string;
  readonly message: string;
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
  readonly email: string | null;
  readonly larkOpenId: string | null;
  readonly sessionId: string;
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
