import type { RuntimeApprovalRepository } from '../../infrastructure/persistence/runtime-approval.repository';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { Logger } from '../../shared/logger';
import type { ApprovalGateService } from './approval-gate.service';
import type { PermissionService } from '../permissions/permission.service';
import type { ToolExecutor, RuntimeToolExecutionOutcome } from '../gateway/tool-executor';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import { asChatId, asCompanyId, asCorrelationId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';

export interface ApprovalResumerDeps {
  approvalRepo:        RuntimeApprovalRepository;
  larkAdapter:         LarkChannelAdapter;
  channelIdentityRepo: ChannelIdentityRepoPort;
  approvalGate:        ApprovalGateService;
  toolExecutor:        ToolExecutor;
  permissions:         PermissionService;
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

    const meta = asRecord(approval.metadataJson);
    const payload = asRecord(approval.payloadJson);
    const chatId = asNonEmptyString(meta['chatId']);
    const requesterId = asNonEmptyString(meta['requesterId']);
    const requesterLarkOpenId = asNonEmptyString(meta['requesterLarkOpenId']);
    const statusMessageId = asNonEmptyString(meta['statusMessageId']);

    if (!chatId || !requesterId) {
      this.log.error('resumer.missing_metadata', { approvalId });
      return;
    }

    const correlationId = asCorrelationId(`approval-${approvalId}`);
    const conversation = {
      channel: 'lark' as const,
      chatId: asChatId(chatId),
      correlationId,
    };
    if (statusMessageId) {
      this.deps.larkAdapter.restoreStatusCoordinator(String(correlationId), statusMessageId, chatId);
    }

    if (decision === 'rejected') {
      await this.deliverFinal(conversation, 'The requested action was not approved by the manager, so nothing was changed.');
      await this.deps.approvalRepo.persistResult(approvalId, { decision: 'rejected' });
      return;
    }

    const toolId = asNonEmptyString(payload['toolId']);
    const args = asArgs(payload['args']);
    if (!toolId || toolId !== approval.toolId || !args) {
      const message = 'The approved action record is incomplete or no longer matches the requested action.';
      this.log.error('resumer.invalid_approved_payload', { approvalId, storedToolId: approval.toolId, payloadToolId: toolId });
      await this.deps.approvalRepo.failApprovedExecution(approvalId, { status: 'invalid_payload', message });
      await this.deliverFinal(conversation, message);
      return;
    }

    const identityResult = requesterLarkOpenId
      ? await this.deps.channelIdentityRepo.resolveByLarkOpenId(requesterLarkOpenId)
      : await this.deps.channelIdentityRepo.resolveByUserId(requesterId);
    if (!identityResult.ok || !identityResult.value) {
      const message = 'I could not verify the requester for this approved action, so it was not executed.';
      this.log.warn('resumer.identity_not_found', { approvalId, requesterId, requesterLarkOpenId });
      await this.deps.approvalRepo.failApprovedExecution(approvalId, { status: 'identity_not_found', message });
      await this.deliverFinal(conversation, message);
      return;
    }
    const identity = identityResult.value;

    const permissionResult = await this.deps.permissions.resolve({
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: 'lark',
      ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
    });
    if (!permissionResult.ok) {
      const message = `The approved action can no longer be run: ${permissionResult.error.message}`;
      this.log.warn('resumer.permission_denied', { approvalId, reason: permissionResult.error.message });
      await this.deps.approvalRepo.failApprovedExecution(approvalId, { status: 'permission_denied', message });
      await this.deliverFinal(conversation, message);
      return;
    }

    const runContext = {
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      channel: 'lark' as const,
      traceId: String(correlationId),
      requestId: `approval-${approvalId}`,
      chatId,
      requesterAiRole: identity.aiRole,
      ...(requesterLarkOpenId ?? identity.larkOpenId
        ? { userExternalId: requesterLarkOpenId ?? identity.larkOpenId }
        : {}),
      ...(identity.email ? { requesterEmail: identity.email } : {}),
      ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
      ...(permissionResult.value.department?.zohoReadScope
        ? { departmentZohoReadScope: permissionResult.value.department.zohoReadScope }
        : {}),
    };

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

    const outcome = await this.deps.toolExecutor.executeForRuntime({
      toolId,
      args,
      runContext,
      perm: permissionResult.value,
      approvalGate: this.deps.approvalGate,
      chatId,
      expectedAction: approval.actionGroup as ToolActionGroup,
    });
    await this.finishApprovedAction(approvalId, conversation, outcome);
  }

  private async finishApprovedAction(
    approvalId: string,
    conversation: { channel: 'lark'; chatId: ReturnType<typeof asChatId>; correlationId: ReturnType<typeof asCorrelationId> },
    outcome: RuntimeToolExecutionOutcome,
  ): Promise<void> {
    if (outcome.status === 'success') {
      const text = ['Approved action completed.', renderResult(outcome.result)].filter(Boolean).join('\n\n');
      await this.deliverFinal(conversation, text);
      return;
    }

    const message = outcome.message ?? 'The approved action could not be completed.';
    this.log.warn('resumer.approved_execution_failed', {
      approvalId,
      toolId: outcome.toolId,
      status: outcome.status,
      message,
    });
    await this.deps.approvalRepo.failApprovedExecution(approvalId, {
      status: outcome.status,
      message,
    });
    await this.deliverFinal(conversation, `The approved action could not be completed: ${message}`);
  }

  private async deliverFinal(
    conversation: { channel: 'lark'; chatId: ReturnType<typeof asChatId>; correlationId: ReturnType<typeof asCorrelationId> },
    text: string,
  ): Promise<void> {
    const delivered = await this.deps.larkAdapter.sendFinalReply(conversation, {
      kind: 'final',
      text,
      format: 'markdown',
    });
    if (!delivered.ok) {
      this.log.error('resumer.delivery_failed', { error: delivered.error.message });
    }
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

function renderResult(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value, null, 2);
  if (!serialized) return '';
  return `Result:\n\n\`\`\`json\n${serialized.slice(0, 3_500)}\n\`\`\``;
}
