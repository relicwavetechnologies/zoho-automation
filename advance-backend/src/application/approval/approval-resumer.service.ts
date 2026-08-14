import type { RuntimeApprovalRepository } from '../../infrastructure/persistence/runtime-approval.repository';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { ConversationHandle } from '../channels/channel.adapter';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { Logger } from '../../shared/logger';
import type { ApprovalGateService } from './approval-gate.service';
import type { PermissionService } from '../permissions/permission.service';
import type { ToolExecutor, RuntimeToolExecutionOutcome } from '../gateway/tool-executor';
import type { GatewayExecutionContext } from '../gateway/gateway.types';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import {
  asChatId,
  asCompanyId,
  asCorrelationId,
  asDepartmentId,
  asMessageId,
  asUserId,
} from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { isAutomationPlanApproval } from '../gateway/automation-plan.service';
import type { AutomationPlanExecutor } from '../gateway/automation-plan.executor';
import type { ChannelKey } from '../../domain/channel/incoming-message';

/** An outcome and the adapter that can actually reach its destination. */
interface FinalDelivery {
  readonly adapter: Pick<LarkChannelAdapter, 'sendFinalReply'>;
  readonly conversation: ConversationHandle;
}

export interface ApprovalResumerDeps {
  approvalRepo:        RuntimeApprovalRepository;
  larkAdapter:         LarkChannelAdapter;
  /**
   * Delivery for an approval that came from a scheduled run.
   *
   * Such a run has no chat: its recorded conversation is the synthetic
   * `scheduled-workflow:<id>` thread, which Lark cannot receive a message on.
   * This adapter reads the conversation id as the creator's open_id, so the
   * outcome reaches the one person entitled to it instead of failing silently.
   *
   * Required rather than optional: omitting it would silently restore that
   * failure for exactly the runs this exists to protect, and the only trace
   * would be a generic delivery error.
   */
  scheduledDmAdapter:  Pick<LarkChannelAdapter, 'sendFinalReply'>;
  channelIdentityRepo: ChannelIdentityRepoPort;
  approvalGate:        ApprovalGateService;
  toolExecutor:        ToolExecutor;
  permissions:         PermissionService;
  /** Handles immutable multi-call batches that were approved in a Lark DM. */
  automationPlanExecutor?: AutomationPlanExecutor;
  logger:              Logger;
}

/**
 * Finishes exactly the tool action stored in the approval record.
 *
 * Approval is a decision over one validated set of arguments, not a request
 * to re-run the supervisor. Re-planning through an LLM here could select a
 * different tool or mutate the arguments after the manager has approved.
 */
export class ApprovalResumerService {
  private readonly log: Logger;

  constructor(private readonly deps: ApprovalResumerDeps) {
    this.log = deps.logger.child({ service: 'approval-resumer' });
  }

  async resume(approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const found = await this.deps.approvalRepo.findById(approvalId);
    if (!found.ok || !found.value) {
      this.log.warn('resumer.approval_not_found', { approvalId });
      return;
    }
    const approval = found.value;
    if (approval.status !== decision) {
      this.log.warn('resumer.approval_not_resolved_as_requested', {
        approvalId,
        expected: decision,
        actual: approval.status,
      });
      return;
    }

    if (isAutomationPlanApproval(approval)) {
      if (!this.deps.automationPlanExecutor) {
        this.log.error('resumer.automation_plan_executor_missing', { approvalId });
        return;
      }
      await this.deps.automationPlanExecutor.resume(approval, decision);
      return;
    }

    const meta = asRecord(approval.metadataJson);
    const payload = asRecord(approval.payloadJson);
    const storedChatId = asNonEmptyString(meta['chatId']);
    const chatId = asNonEmptyString(meta['sourceChatId'])
      ?? legacySourceChatId(storedChatId, meta['approvalOrigin']);
    const requesterId = asNonEmptyString(meta['requesterId']);
    const requesterLarkOpenId = asNonEmptyString(meta['requesterLarkOpenId']);
    const tenantKey = asNonEmptyString(meta['tenantKey']);
    const statusMessageId = asNonEmptyString(meta['statusMessageId']);
    const replyToMessageId = asNonEmptyString(meta['replyToMessageId']);
    const replyInThread = typeof meta['replyInThread'] === 'boolean'
      ? meta['replyInThread']
      : undefined;
    const deliveryMode = meta['deliveryMode'] === 'scheduled_runtime_delivery'
      ? 'scheduled_runtime_delivery' as const
      : undefined;
    const approvalOrigin = asNonEmptyString(meta['approvalOrigin']);
    const sourceChannel = asChannel(meta['sourceChannel'])
      ?? (approvalOrigin === 'cloud_pi' || approvalOrigin === 'lark' ? 'lark' : 'desktop');
    const parentBusinessActionId = asNonEmptyString(meta['parentBusinessActionId']);
    const execution = asExecutionContext(meta['execution']);
    const approvalCompanyId = asNonEmptyString(approval.companyId);

    if (!chatId || !requesterId || !approvalCompanyId) {
      this.log.error('resumer.missing_metadata', { approvalId });
      return;
    }

    const correlationId = asCorrelationId(`approval-${approvalId}`);
    const conversation = {
      channel: 'lark' as const,
      chatId: asChatId(chatId),
      ...(replyToMessageId ? { replyToMessageId: asMessageId(replyToMessageId) } : {}),
      ...(replyInThread !== undefined ? { replyInThread } : {}),
      correlationId,
    };
    if (sourceChannel === 'lark' && statusMessageId) {
      this.deps.larkAdapter.restoreStatusCoordinator(String(correlationId), statusMessageId, chatId);
    }

    // Where the outcome goes. A scheduled run has no chat to report into — its
    // recorded conversation is the synthetic `scheduled-workflow:<id>` thread —
    // so the result is addressed to the creator instead, through the one adapter
    // that reads a conversation id as an open_id.
    const scheduledToCreator = deliveryMode === 'scheduled_runtime_delivery'
      && Boolean(requesterLarkOpenId);
    const delivery: FinalDelivery | null = sourceChannel !== 'lark' && !scheduledToCreator
      ? null
      : scheduledToCreator
      ? {
          adapter: this.deps.scheduledDmAdapter,
          conversation: { ...conversation, chatId: asChatId(requesterLarkOpenId!) },
        }
      : { adapter: this.deps.larkAdapter, conversation };

    if (decision === 'rejected') {
      await this.deliverFinal(delivery, 'The requested action was not approved by the manager, so nothing was changed.');
      await this.deps.approvalRepo.persistResult(approvalId, { decision: 'rejected' });
      if (parentBusinessActionId) {
        const response = { ok: false, status: 'approval_rejected', error: {
          code: 'approval_rejected',
          message: 'The manager did not approve this action, so nothing was changed.',
        } } as const;
        await this.deps.approvalRepo.failLinkedBusinessAction(
          parentBusinessActionId,
          'rejected',
          response,
        );
      }
      return;
    }

    const toolId = asNonEmptyString(payload['toolId']);
    const args = asArgs(payload['args']);
    if (!toolId || toolId !== approval.toolId || !args) {
      const message = 'The approved action record is incomplete or no longer matches the requested action.';
      this.log.error('resumer.invalid_approved_payload', { approvalId, storedToolId: approval.toolId, payloadToolId: toolId });
      await this.persistFailure(approvalId, { status: 'invalid_payload', message });
      await this.deliverFinal(delivery, message);
      return;
    }

    if (approvalOrigin === 'cloud_pi' && !execution) {
      const message = 'The approved cloud action is missing its verified Pi execution context, so it was not executed.';
      this.log.error('resumer.invalid_cloud_pi_execution', { approvalId });
      await this.persistFailure(approvalId, { status: 'invalid_execution_context', message });
      await this.deliverFinal(delivery, message);
      return;
    }

    if (requesterLarkOpenId && !tenantKey) {
      const message = 'I could not verify the Lark workspace for this approved action, so it was not executed.';
      this.log.warn('resumer.tenant_missing', { approvalId, requesterId, requesterLarkOpenId });
      await this.persistFailure(approvalId, { status: 'tenant_missing', message });
      await this.deliverFinal(delivery, message);
      return;
    }

    const identityResult = requesterLarkOpenId
      ? await this.deps.channelIdentityRepo.resolveByLarkTenantIdentity(requesterLarkOpenId, tenantKey!)
      : await this.deps.channelIdentityRepo.resolveByUserId(requesterId, approvalCompanyId);
    if (!identityResult.ok || !identityResult.value) {
      const message = 'I could not verify the requester for this approved action, so it was not executed.';
      this.log.warn('resumer.identity_not_found', { approvalId, requesterId, requesterLarkOpenId });
      await this.persistFailure(approvalId, { status: 'identity_not_found', message });
      await this.deliverFinal(delivery, message);
      return;
    }
    const identity = identityResult.value;
    if (identity.companyId !== approvalCompanyId || identity.userId !== requesterId) {
      const message = 'I could not verify the requester company for this approved action, so it was not executed.';
      this.log.warn('resumer.identity_scope_mismatch', {
        approvalId,
        requesterId,
        approvalCompanyId,
        identityCompanyId: identity.companyId,
        identityUserId: identity.userId,
      });
      await this.persistFailure(approvalId, { status: 'identity_scope_mismatch', message });
      await this.deliverFinal(delivery, message);
      return;
    }

    const permissionResult = await this.deps.permissions.resolve({
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: sourceChannel,
      ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
    });
    if (!permissionResult.ok) {
      const message = `The approved action can no longer be run: ${permissionResult.error.message}`;
      this.log.warn('resumer.permission_denied', { approvalId, reason: permissionResult.error.message });
      await this.persistFailure(approvalId, { status: 'permission_denied', message });
      await this.deliverFinal(delivery, message);
      return;
    }

    const runContext = {
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: sourceChannel,
      traceId: String(correlationId),
      requestId: `approval-${approvalId}`,
      chatId,
      requesterAiRole: identity.aiRole,
      ...(tenantKey ? { tenantId: tenantKey } : {}),
      ...(requesterLarkOpenId ?? identity.larkOpenId
        ? { userExternalId: requesterLarkOpenId ?? identity.larkOpenId }
        : {}),
      ...(identity.email ? { requesterEmail: identity.email } : {}),
      // Replayed from the request, not re-derived: the session that ran the
      // scheduled work is revoked by the time an approval comes back.
      ...(deliveryMode ? { deliveryMode } : {}),
      ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
      ...(permissionResult.value.department?.zohoReadScope
        ? { departmentZohoReadScope: permissionResult.value.department.zohoReadScope }
        : {}),
    };

    // Skipped for a scheduled run: this card would be addressed to the synthetic
    // thread the run carries, which is not a chat anyone can receive on, and
    // there is no live conversation waiting on progress either way.
    if (delivery && !scheduledToCreator) {
      await this.deps.larkAdapter.sendStatus(conversation, {
        kind: 'status',
        terminal: false,
        timeline: {
          phase: 'Completing approved action',
          progressPct: 75,
          completedSteps: 1,
          totalSteps: 2,
          liveLabel: 'Executing the exact approved action…',
        },
      });
    }

    const outcome = await this.deps.toolExecutor.executeForRuntime({
      toolId,
      args,
      runContext,
      perm: permissionResult.value,
      approvalGate: this.deps.approvalGate,
      // Replay with the unscoped conversation id. metadata.chatId is already
      // approval-scoped; passing it back through the gate would double-scope and
      // miss the approved grant.
      chatId,
      expectedAction: approval.actionGroup as ToolActionGroup,
      ...(execution ? { execution } : {}),
    });
    await this.finishApprovedAction(approvalId, delivery, outcome, parentBusinessActionId);
  }

  private async finishApprovedAction(
    approvalId: string,
    delivery: FinalDelivery | null,
    outcome: RuntimeToolExecutionOutcome,
    parentBusinessActionId?: string,
  ): Promise<void> {
    if (outcome.status === 'success') {
      const response = {
        ok: true,
        status: 'success',
        data: { toolId: outcome.toolId, action: outcome.action, result: outcome.result },
      } as const;
      if (parentBusinessActionId) {
        await this.deps.approvalRepo.completeLinkedBusinessAction(
          parentBusinessActionId,
          response,
        );
      }
      const text = ['Approved action completed.', renderResult(outcome.result)].filter(Boolean).join('\n\n');
      await this.deliverFinal(delivery, text);
      return;
    }

    const message = outcome.message ?? 'The approved action could not be completed.';
    this.log.warn('resumer.approved_execution_failed', {
      approvalId,
      toolId: outcome.toolId,
      status: outcome.status,
      message,
    });
    await this.persistFailure(approvalId, {
      status: outcome.status,
      message,
    });
    await this.deliverFinal(delivery, `The approved action could not be completed: ${message}`);
  }

  private async deliverFinal(
    delivery: FinalDelivery | null,
    text: string,
  ): Promise<void> {
    if (!delivery) return;
    const delivered = await delivery.adapter.sendFinalReply(delivery.conversation, {
      kind: 'final',
      text,
      format: 'markdown',
    });
    if (!delivered.ok) {
      this.log.error('resumer.delivery_failed', { error: delivered.error.message });
    }
  }

  private async persistFailure(approvalId: string, result: Record<string, unknown>): Promise<boolean> {
    const persisted = await this.deps.approvalRepo.failApprovedExecution(approvalId, result);
    if (persisted.ok && persisted.value) {
      const found = await this.deps.approvalRepo.findById(approvalId);
      const parentBusinessActionId = found.ok && found.value
        ? asNonEmptyString(asRecord(found.value.metadataJson)['parentBusinessActionId'])
        : undefined;
      if (parentBusinessActionId) {
        const response = {
          ok: false,
          status: 'approval_execution_failed',
          error: {
            code: 'approval_execution_failed',
            message: typeof result['message'] === 'string'
              ? result['message']
              : 'The approved action could not be completed.',
          },
        } as const;
        await this.deps.approvalRepo.failLinkedBusinessAction(
          parentBusinessActionId,
          'failed',
          response,
        );
      }
      return true;
    }
    this.log.error('resumer.failure_checkpoint_failed', {
      approvalId,
      error: persisted.ok ? 'approval_not_approved_or_executing' : persisted.error.message,
    });
    return false;
  }

}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArgs(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asChannel(value: unknown): ChannelKey | undefined {
  return value === 'lark' || value === 'desktop' || value === 'airnote' || value === 'web'
    ? value
    : undefined;
}

function asExecutionContext(value: unknown): GatewayExecutionContext | undefined {
  const record = asRecord(value);
  const threadId = asNonEmptyString(record['threadId']);
  const runId = asNonEmptyString(record['runId']);
  const actionId = asNonEmptyString(record['actionId']);
  if (record['version'] !== 1 || !threadId || !runId || !actionId) return undefined;
  return { version: 1, threadId, runId, actionId };
}

/**
 * What to tell somebody whose approved action just ran.
 *
 * This path does not go through the model — the approval came back long after
 * the run that asked for it, and re-running a model to describe a completed
 * write would risk it describing one that did not happen. So whatever this
 * returns is read verbatim by a person.
 *
 * It used to be the tool's whole return value as a JSON code block. A member
 * who approved a mail rule was shown twenty-three lines of `ruleId`,
 * `connectionId` and nested `destination` objects to say one sentence's worth
 * of thing. Tools already write that sentence — `message` is where it goes —
 * and it is the tool's own words rather than an interpretation of them.
 *
 * The JSON stays as the fallback, because a result with no `message` is one
 * nobody has written a sentence for, and showing its fields is still better
 * than showing nothing.
 */
function renderResult(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  const serialized = JSON.stringify(value, null, 2);
  if (!serialized) return '';
  return `Result:\n\n\`\`\`json\n${serialized.slice(0, 3_500)}\n\`\`\``;
}

function legacySourceChatId(chatId: string | undefined, origin: unknown): string | undefined {
  if (!chatId || origin !== 'lark') return chatId;
  const scopeMarker = ':approval:';
  const markerIndex = chatId.indexOf(scopeMarker);
  return markerIndex > 0 ? chatId.slice(0, markerIndex) : chatId;
}
