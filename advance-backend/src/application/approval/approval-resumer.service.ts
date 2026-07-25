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
import { isAutomationPlanApproval } from '../gateway/automation-plan.service';
import type { AutomationPlanExecutor } from '../gateway/automation-plan.executor';

export interface ApprovalResumerDeps {
  approvalRepo:        RuntimeApprovalRepository;
  larkAdapter:         LarkChannelAdapter;
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
    const approvalCompanyId = asNonEmptyString(approval.companyId);

    if (!chatId || !requesterId || !approvalCompanyId) {
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
      await this.persistFailure(approvalId, { status: 'invalid_payload', message });
      await this.deliverFinal(conversation, message);
      return;
    }

    if (requesterLarkOpenId && !tenantKey) {
      const message = 'I could not verify the Lark workspace for this approved action, so it was not executed.';
      this.log.warn('resumer.tenant_missing', { approvalId, requesterId, requesterLarkOpenId });
      await this.persistFailure(approvalId, { status: 'tenant_missing', message });
      await this.deliverFinal(conversation, message);
      return;
    }

    const identityResult = requesterLarkOpenId
      ? await this.deps.channelIdentityRepo.resolveByLarkTenantIdentity(requesterLarkOpenId, tenantKey!)
      : await this.deps.channelIdentityRepo.resolveByUserId(requesterId, approvalCompanyId);
    if (!identityResult.ok || !identityResult.value) {
      const message = 'I could not verify the requester for this approved action, so it was not executed.';
      this.log.warn('resumer.identity_not_found', { approvalId, requesterId, requesterLarkOpenId });
      await this.persistFailure(approvalId, { status: 'identity_not_found', message });
      await this.deliverFinal(conversation, message);
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
      await this.deliverFinal(conversation, message);
      return;
    }

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
      await this.persistFailure(approvalId, { status: 'permission_denied', message });
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
    await this.persistFailure(approvalId, {
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

  private async persistFailure(approvalId: string, result: Record<string, unknown>): Promise<boolean> {
    const persisted = await this.deps.approvalRepo.failApprovedExecution(approvalId, result);
    if (persisted.ok && persisted.value) return true;
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

function renderResult(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
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
