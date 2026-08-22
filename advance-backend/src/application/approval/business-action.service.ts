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
import type { DecisionService } from '../decision/decision.service';

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
    readonly decisions: Pick<DecisionService, 'ask'>;
    readonly toolExecutor: ToolExecutor;
    readonly logger: Logger;
    /**
     * Where the outcome of a confirmed action is written down.
     *
     * The same port and the same shape the manager-approval path already uses
     * in `ApprovalResumerService`, because the two were asymmetric and only one
     * of them told the thread anything. A manager approval appended "Approved
     * action completed."; a requester confirmation executed, recorded itself in
     * the database, answered the browser, and left the transcript untouched.
     *
     * The consequence was not a missing line. It was the agent contradicting
     * reality: with no completion in its context, the next turn still saw the
     * staged ask and told somebody their calendar event had not been created
     * while the event sat in their calendar. Absent information became a
     * confident false statement.
     *
     * It lives here rather than in the callers because this module owns the
     * requester-confirmation lifecycle end to end, and there are two callers.
     * Optional for the same reason the resumer's is: a deployment without it
     * behaves as this did before, which is worth a missing dependency rather
     * than a crash.
     */
    readonly webTranscript?: {
      appendTurn(
        chatId: string,
        turn: { role: 'user' | 'assistant'; content: string; timestamp: string },
        scope: { companyId: string; channel: string },
        metadata?: { dedupeKey?: string; sourceRunId?: string },
      ): Promise<unknown>;
    };
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

    const asked = await this.deps.decisions.ask({
      kind: 'tool_action',
      companyId: member.companyId,
      approver: {
        userId: member.userId,
        displayName: member.email ?? member.userId,
        // Requester confirmations stay in the surface that raised them. The
        // person is already looking at that surface, so no manager card is sent.
        larkOpenId: null,
      },
      requestedBy: { userId: member.userId, displayName: member.email ?? member.userId },
      summary: presentation.title,
      toolId: prepared.toolId,
      action: prepared.action,
      rowKind: 'business_action',
      args,
      argsHash,
      metadata: {
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
      conversationKey: `business-action:${scope}`,
      idempotencyKey,
      initialStatus: 'pending',
    });

    if (!asked.ok) {
      this.deps.logger.error('business_action.prepare_failed', {
        toolId: prepared.toolId,
        userId: member.userId,
        reason: asked.reason,
        rowId: asked.rowId,
      });
      return gatewayFailure('tool_error', 'Divo could not prepare this action for review. Please try again.');
    }

    const action = asked.row;
    const terminal = responseFromExisting(action);
    if (terminal) return terminal;

    this.deps.logger.info('business_action.prepared', {
      actionId: action.id,
      toolId: prepared.toolId,
      action: prepared.action,
      channel,
      created: asked.created,
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
      /* Recorded for the same reason the success is. An agent that cannot see
         the cancellation will offer to go ahead again as though nothing was
         said, which reads as not listening. */
      await this.recordOutcome(
        action.id,
        readExecution(asRecord(action.metadataJson)['execution']),
        input.member,
        'You cancelled this action. Nothing was changed.',
      );
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
      parentDecisionId: action.id,
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
      await this.recordOutcome(action.id, execution, input.member, 'The action you confirmed has been completed.');
    } else {
      await this.deps.approvals.failApprovedExecution(action.id, response);
      await this.recordOutcome(
        action.id,
        execution,
        input.member,
        `The action you confirmed could not be completed: ${failureText(response)}`,
      );
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

  /**
   * Write what happened into the thread the action was raised from.
   *
   * Keyed on the action so the same confirmation resolved twice — from a card
   * and a browser tab racing each other — leaves one line rather than two.
   * The key carries the verdict-independent id because only one verdict can
   * ever win the atomic resolve above.
   *
   * Failures to write are logged and swallowed. The action has already run; a
   * transcript that could not be appended must not turn a completed calendar
   * event into an error handed back to the person who confirmed it.
   */
  private async recordOutcome(
    actionId: string,
    execution: GatewayExecutionContext | undefined,
    member: GatewayMemberContext,
    text: string,
  ): Promise<void> {
    if (!this.deps.webTranscript || !execution?.threadId) return;
    await this.deps.webTranscript.appendTurn(
      execution.threadId,
      { role: 'assistant', content: text, timestamp: new Date().toISOString() },
      { companyId: member.companyId, channel: 'web' },
      { dedupeKey: `business_action:${actionId}:outcome` },
    ).catch((error: unknown) => this.deps.logger.error('business_action.outcome_write_failed', {
      actionId,
      error: String(error),
    }));
  }
}

/** The reason a gateway failure carries, if it carries one. */
function failureText(response: GatewayResponse): string {
  if (response.ok) return 'no reason was given.';
  const message = response.error?.message;
  return message ? (message.endsWith('.') ? message : `${message}.`) : 'no reason was given.';
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
