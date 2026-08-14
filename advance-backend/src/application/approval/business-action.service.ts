import type { Logger } from '../../shared/logger';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import { computeArgsHash, computeIdempotencyKey } from './approval-policy';
import { describeBusinessAction } from './business-action-presentation';
import type { PreparedToolInvocation, ToolExecutor } from '../gateway/tool-executor';
import type {
  GatewayExecutionContext,
  GatewayMemberContext,
  GatewayResponse,
} from '../gateway/gateway.types';
import { gatewayFailure, gatewaySuccess } from '../gateway/gateway.types';

const BUSINESS_ACTION_TTL_MS = 24 * 60 * 60 * 1_000;

export interface PrepareBusinessActionInput {
  readonly member: GatewayMemberContext;
  readonly departmentId?: string;
  readonly skillId?: string;
  readonly execution?: GatewayExecutionContext;
  readonly prepared: PreparedToolInvocation;
}

export interface DecideBusinessActionInput {
  readonly member: GatewayMemberContext;
  readonly actionId: string;
  readonly decision: 'approved' | 'rejected';
}

export type BusinessActionDecisionResult =
  | { readonly handled: false }
  | { readonly handled: true; readonly response: GatewayResponse };

/**
 * The backend-owned lifecycle for one exact business mutation.
 *
 * Its interface deliberately has only preparation and decision. Persistence,
 * actor checks, immutable arguments, execution claiming, manager hand-off and
 * replay behaviour remain inside the module.
 */
export class BusinessActionService {
  constructor(private readonly deps: {
    readonly approvals: RuntimeApprovalRepository;
    readonly toolExecutor: ToolExecutor;
    readonly logger: Logger;
  }) {}

  async prepare(input: PrepareBusinessActionInput): Promise<GatewayResponse> {
    const { member, prepared } = input;
    if (prepared.action === 'read') {
      return gatewayFailure('invalid_args', 'Read actions do not require requester confirmation.');
    }

    const args = cloneRecord(prepared.args);
    const argsHash = computeArgsHash(args);
    const presentation = describeBusinessAction(prepared.toolId, prepared.action, args);
    const scope = businessActionScope(member, input.execution);
    const idempotencyKey = computeIdempotencyKey(
      `business-action:${scope}`,
      prepared.toolId,
      prepared.action,
      argsHash,
    );
    const channel = member.channel ?? 'desktop';

    const stored = await this.deps.approvals.createOrReuseActive({
      chatId: `business-action:${scope}`,
      companyId: member.companyId,
      toolId: prepared.toolId,
      actionGroup: prepared.action,
      kind: 'business_action',
      summary: presentation.title,
      payloadJson: {
        toolId: prepared.toolId,
        action: prepared.action,
        args,
        argsHash,
      },
      metadataJson: {
        decisionKind: 'requester_confirmation',
        resolvedDecisionUserId: member.userId,
        // Compatibility with the existing inbox query during the migration to
        // generic decision ownership.
        resolvedManagerUserId: member.userId,
        requesterId: member.userId,
        requesterName: member.email ?? member.userId,
        requesterEmail: member.email ?? null,
        companyId: member.companyId,
        aiRole: member.aiRole,
        sessionId: member.sessionId,
        sourceChannel: channel,
        departmentId: input.departmentId ?? null,
        skillId: input.skillId ?? null,
        execution: input.execution ?? null,
        presentation,
        approvalOrigin: 'gateway',
        autoResume: true,
      },
      channel,
      requestedBy: member.userId,
      idempotencyKey,
      expiresAt: new Date(Date.now() + BUSINESS_ACTION_TTL_MS),
      initialStatus: 'pending',
    });

    if (!stored.ok) {
      this.deps.logger.error('business_action.prepare_failed', {
        toolId: prepared.toolId,
        userId: member.userId,
        error: stored.error.message,
      });
      return gatewayFailure('tool_error', 'Divo could not prepare this action for review. Please try again.');
    }

    const action = stored.value.approval;
    const terminal = responseFromExisting(action);
    if (terminal) return terminal;

    this.deps.logger.info('business_action.prepared', {
      actionId: action.id,
      toolId: prepared.toolId,
      action: prepared.action,
      channel,
      created: stored.value.created,
      userId: member.userId,
      companyId: member.companyId,
      threadId: input.execution?.threadId ?? null,
      runId: input.execution?.runId ?? null,
    });

    return gatewaySuccess({
      action: prepared.action,
      requiresApproval: true,
      decisionKind: 'requester_confirmation',
      intentId: action.id,
      kind: presentation.kind,
      title: presentation.title,
      presentation,
      argsHash,
      expiresAt: action.expiresAt?.toISOString() ?? null,
    });
  }

  async decide(input: DecideBusinessActionInput): Promise<BusinessActionDecisionResult> {
    const found = await this.deps.approvals.findById(input.actionId);
    if (!found.ok || !found.value || found.value.kind !== 'business_action') {
      return { handled: false };
    }
    const action = found.value;
    if (!ownedBy(action, input.member)) {
      return {
        handled: true,
        response: gatewayFailure('permission_denied', 'This action is waiting on the person who requested it.'),
      };
    }
    if (action.expiresAt && action.expiresAt.getTime() <= Date.now()) {
      return {
        handled: true,
        response: gatewayFailure('approval_intent_expired', 'This action expired. Ask Divo to prepare it again.'),
      };
    }

    const existing = responseFromExisting(action);
    if (existing) return { handled: true, response: existing };
    if (action.status !== 'pending' && action.status !== 'dispatching') {
      return {
        handled: true,
        response: gatewayFailure('approval_intent_busy', 'This action is already being decided.'),
      };
    }

    const resolved = await this.deps.approvals.atomicResolve(
      action.id,
      input.decision,
      input.member.userId,
      input.decision === 'rejected' ? 'requester_rejected' : 'requester_confirmed',
    );
    if (!resolved.ok || !resolved.value) {
      return {
        handled: true,
        response: gatewayFailure('approval_intent_busy', 'This action was already decided in another window.'),
      };
    }

    if (input.decision === 'rejected') {
      const response = gatewayFailure('approval_rejected', 'Cancelled. Nothing was changed.');
      await this.deps.approvals.persistResult(action.id, response);
      this.deps.logger.info('business_action.rejected', { actionId: action.id, userId: input.member.userId });
      return { handled: true, response };
    }

    const claimed = await this.deps.approvals.claimApprovedExecution(action.id, input.member.userId);
    if (!claimed.ok || !claimed.value) {
      return {
        handled: true,
        response: gatewayFailure('approval_intent_busy', 'This action is already being executed.'),
      };
    }

    const payload = asRecord(action.payloadJson);
    const metadata = asRecord(action.metadataJson);
    const args = asRecord(payload['args']);
    const toolId = readString(payload['toolId']);
    const expectedAction = readString(payload['action']);
    const storedHash = readString(payload['argsHash']);
    if (!toolId || !expectedAction || !args || !storedHash || computeArgsHash(args) !== storedHash) {
      const response = gatewayFailure('invalid_args', 'The reviewed action failed its integrity check. Prepare it again.');
      await this.deps.approvals.failApprovedExecution(action.id, response);
      return { handled: true, response };
    }

    const departmentId = readString(metadata['departmentId']);
    const execution = readExecution(metadata['execution']);
    const response = await this.deps.toolExecutor.invoke({
      member: input.member,
      ...(departmentId ? { departmentId } : {}),
      toolId,
      args: cloneRecord(args),
      expectedAction: expectedAction as PreparedToolInvocation['action'],
      ...(execution ? { execution } : {}),
      resumeOnApproval: true,
      parentBusinessActionId: action.id,
    });

    if (response.status === 'approval_required') {
      const waiting = await this.deps.approvals.markAwaitingGovernance(action.id, response);
      if (!waiting.ok || !waiting.value) {
        const failure = gatewayFailure('tool_error', 'Manager approval was requested, but Divo could not preserve this action safely.');
        await this.deps.approvals.failApprovedExecution(action.id, failure);
        return {
          handled: true,
          response: failure,
        };
      }
    } else if (response.ok) {
      await this.deps.approvals.completeApprovedExecution(action.id, response);
    } else {
      await this.deps.approvals.failApprovedExecution(action.id, response);
    }
    this.deps.logger.info('business_action.decided', {
      actionId: action.id,
      decision: input.decision,
      status: response.status,
      toolId,
      userId: input.member.userId,
    });
    return { handled: true, response };
  }
}

function businessActionScope(
  member: GatewayMemberContext,
  execution: GatewayExecutionContext | undefined,
): string {
  if (!execution) return `${member.companyId}:${member.userId}:session:${member.sessionId}`;
  return `${member.companyId}:${member.userId}:${execution.threadId}:${execution.runId}:${execution.actionId}`;
}

function ownedBy(action: RuntimeApprovalRow, member: GatewayMemberContext): boolean {
  const metadata = asRecord(action.metadataJson);
  return action.companyId === member.companyId
    && action.requestedBy === member.userId
    && readString(metadata['resolvedDecisionUserId']) === member.userId;
}

function responseFromExisting(action: RuntimeApprovalRow): GatewayResponse | null {
  if (action.status === 'pending' || action.status === 'dispatching') return null;
  const stored = asGatewayResponse(action.executionResultJson);
  if (stored) return stored;
  if (action.status === 'approved' || action.status === 'executing') {
    return gatewayFailure('approval_intent_busy', 'This action is already being executed.');
  }
  if (action.status === 'awaiting_governance') {
    return gatewayFailure('approval_required', 'This action is waiting for company approval.');
  }
  if (action.status === 'consumed') {
    return gatewayFailure('approval_intent_consumed', 'This action has already been completed.');
  }
  if (action.status === 'rejected') {
    return gatewayFailure('approval_rejected', 'Cancelled. Nothing was changed.');
  }
  if (action.status === 'failed') {
    return gatewayFailure('approval_execution_failed', 'This action failed after execution started. Review the destination before retrying.');
  }
  return gatewayFailure('approval_intent_busy', `This action is ${action.status}.`);
}

function asGatewayResponse(value: unknown): GatewayResponse | null {
  const record = asRecord(value);
  return typeof record['ok'] === 'boolean' && typeof record['status'] === 'string'
    ? record as unknown as GatewayResponse
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readExecution(value: unknown): GatewayExecutionContext | undefined {
  const record = asRecord(value);
  const threadId = readString(record['threadId']);
  const runId = readString(record['runId']);
  const actionId = readString(record['actionId']);
  return record['version'] === 1 && threadId && runId && actionId
    ? { version: 1, threadId, runId, actionId }
    : undefined;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
