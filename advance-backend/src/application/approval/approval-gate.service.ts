import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PermissionResult } from '../permissions/permission.types';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { Logger } from '../../shared/logger';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import type { ApprovalResolverService } from './approval-resolver.service';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { ApprovalDecision, ApprovalExecutionGrant } from './approval.types';
import { checkApprovalPolicy, computeArgsHash, computeIdempotencyKey } from './approval-policy';
import { buildApprovalCard } from './approval-card-builder';

export interface ApprovalGateInput {
  toolId:         string;
  action:         ToolActionGroup;
  args:           unknown;
  perm:           PermissionResult;
  runContext:     RunContext;
  /** Lark chat_id of the requester's conversation — used for idempotency key. */
  chatId:         string;
  /** Human-readable summary of what the tool call would do (shown on approval card). */
  argsSummary:    string;
}

export interface ApprovalGateOptions {
  readonly disableManagerSelfBypass?: boolean;
}

export class ApprovalGateService {
  constructor(
    private readonly approvalRepo:    RuntimeApprovalRepository,
    private readonly resolver:        ApprovalResolverService,
    private readonly larkAdapter:     LarkChannelAdapter,
    private readonly logger:          Logger,
    private readonly options:         ApprovalGateOptions = {},
  ) {}

  async check(input: ApprovalGateInput): Promise<ApprovalDecision> {
    const { toolId, action, args, perm, runContext, chatId, argsSummary } = input;

    const policyResult = checkApprovalPolicy({ toolId, action, args, perm, runContext });

    if (policyResult.misconfigured) {
      this.logger.warn('approval.gate.policy_misconfigured', { toolId, action });
      return { kind: 'misconfigured', message: policyResult.misconfigured };
    }

    if (!policyResult.required) {
      return { kind: 'allowed' };
    }

    // Approval required. Check idempotency — avoid duplicate cards on agent retry.
    const argsHash      = computeArgsHash(args);
    const idemKey       = computeIdempotencyKey(chatId, toolId, action, argsHash);
    const existingResult = await this.approvalRepo.findActiveByIdempotencyKey(idemKey);

    if (existingResult.ok && existingResult.value) {
      const existing = existingResult.value;
      if (existing.status === 'approved') {
        return this.claimApprovedGrant({
          approval: existing,
          toolId,
          action,
          argsHash,
          runContext,
          chatId,
        });
      }

      if (existing.status === 'pending') {
        this.logger.info('approval.gate.idempotent_pending', { approvalId: existing.id, toolId, action });
        return {
          kind:       'pending',
          approvalId: existing.id,
          message:    `This action is still waiting for manager approval (id: ${existing.id}). The request has already been sent — please wait.`,
        };
      }
    }

    // Resolve the dept manager
    const deptId = perm.department?.id;
    if (!deptId) {
      this.logger.warn('approval.gate.no_dept', { toolId, action });
      return { kind: 'misconfigured', message: 'No department context — cannot resolve approver.' };
    }

    const manager = await this.resolver.resolveManager(String(deptId), String(runContext.companyId));
    if (!manager) {
      this.logger.warn('approval.gate.no_manager', { deptId, companyId: runContext.companyId });
      return {
        kind:    'misconfigured',
        message: 'This action requires manager approval but no approver is configured for this department. Please contact your administrator.',
      };
    }

    // Manager self-bypass: the dept manager doesn't need to approve their own actions.
    if (!this.options.disableManagerSelfBypass && String(runContext.userId) === manager.userId) {
      this.logger.info('approval.gate.self_bypass', { userId: runContext.userId, toolId, action });
      return { kind: 'allowed' };
    }

    // Capture the current status bubble messageId so the resumer can edit
    // the same bubble in place (instead of creating a new one).
    const statusMessageId = runContext.traceId
      ? this.larkAdapter.getStatusMessageId(String(runContext.traceId))
      : undefined;

    // Create the approval record
    const createResult = await this.approvalRepo.create({
      chatId,
      companyId:      String(runContext.companyId),
      toolId,
      actionGroup:    action,
      kind:           'tool_action',
      summary:        argsSummary,
      payloadJson:    { toolId, action, args, argsHash },
      metadataJson:   {
        requesterId:            String(runContext.userId),
        requesterLarkOpenId:    runContext.userExternalId ? String(runContext.userExternalId) : null,
        departmentId:           runContext.departmentId ? String(runContext.departmentId) : null,
        statusMessageId:        statusMessageId ?? null,
        chatId,
        resolvedManagerOpenId:  manager.larkOpenId,
        resolvedManagerUserId:  manager.userId,
        resolvedManagerName:    manager.displayName,
      },
      channel:        'lark',
      requestedBy:    String(runContext.userId),
      idempotencyKey: idemKey,
      expiresAt:      new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    if (!createResult.ok) {
      this.logger.error('approval.gate.create_failed', { error: createResult.error.message });
      return { kind: 'misconfigured', message: 'Failed to create approval request. Please try again.' };
    }

    const approval = createResult.value;

    // Build and send the approval card to the manager
    const deptName = perm.department?.name ?? 'your department';
    const requesterDisplay = String(runContext.userExternalId ?? runContext.userId);
    const cardContent = buildApprovalCard({
      approvalId:     approval.id,
      toolId,
      action,
      summary:        argsSummary,
      requesterName:  requesterDisplay,
      departmentName: deptName,
    });

    const sendResult = await this.larkAdapter.sendDirectCard(manager.larkOpenId, cardContent);
    if (!sendResult.ok) {
      this.logger.warn('approval.gate.card_send_failed', {
        approvalId: approval.id,
        error:      sendResult.error.message,
      });
      const markFailed = await this.approvalRepo.markFailed(approval.id, `card_send_failed:${sendResult.error.message}`);
      if (!markFailed.ok) {
        this.logger.error('approval.gate.mark_failed_failed', {
          approvalId: approval.id,
          error:      markFailed.error.message,
        });
      }
      return {
        kind:    'misconfigured',
        message: 'This action requires manager approval, but the approval card could not be delivered. Please try again or contact your administrator.',
      };
    }

    // Persist the card message ID so the webhook can update it later.
    await this.approvalRepo.setDecisionMessageId(approval.id, sendResult.value.messageId);

    this.logger.info('approval.gate.pending_created', {
      approvalId: approval.id,
      toolId,
      action,
      manager:    manager.displayName,
    });

    return {
      kind:       'pending',
      approvalId: approval.id,
      message:    `I've sent an approval request to ${manager.displayName}. Waiting on their response (id: ${approval.id}).`,
    };
  }

  async completeExecution(grant: ApprovalExecutionGrant, resultJson: unknown): Promise<void> {
    const result = await this.approvalRepo.completeApprovedExecution(grant.approvalId, resultJson);
    if (!result.ok) {
      this.logger.error('approval.gate.complete_execution_failed', {
        approvalId: grant.approvalId,
        error:      result.error.message,
      });
    }
  }

  async failExecution(grant: ApprovalExecutionGrant, resultJson: unknown): Promise<void> {
    const result = await this.approvalRepo.failApprovedExecution(grant.approvalId, resultJson);
    if (!result.ok) {
      this.logger.error('approval.gate.fail_execution_failed', {
        approvalId: grant.approvalId,
        error:      result.error.message,
      });
    }
  }

  private async claimApprovedGrant(input: {
    approval:   RuntimeApprovalRow;
    toolId:     string;
    action:     ToolActionGroup;
    argsHash:   string;
    runContext: RunContext;
    chatId:     string;
  }): Promise<ApprovalDecision> {
    const { approval, toolId, action, argsHash, runContext, chatId } = input;

    if (!isExactApprovalMatch(approval, { toolId, action, argsHash, runContext, chatId })) {
      this.logger.warn('approval.gate.approved_grant_mismatch', { approvalId: approval.id, toolId, action });
      return {
        kind: 'misconfigured',
        message: 'The approved action no longer matches this request. Please ask for approval again.',
      };
    }

    const claimResult = await this.approvalRepo.claimApprovedExecution(approval.id, String(runContext.userId));
    if (!claimResult.ok) {
      this.logger.error('approval.gate.claim_failed', { approvalId: approval.id, error: claimResult.error.message });
      return { kind: 'misconfigured', message: 'Failed to claim the approved action. Please try again.' };
    }

    if (!claimResult.value) {
      this.logger.warn('approval.gate.claim_unavailable', { approvalId: approval.id });
      return {
        kind: 'misconfigured',
        message: 'This approval has already been used or expired. Please ask for approval again.',
      };
    }

    this.logger.info('approval.gate.approved_grant_claimed', { approvalId: approval.id, toolId, action });
    return { kind: 'allowed', executionGrant: { approvalId: approval.id } };
  }
}

function isExactApprovalMatch(
  approval: RuntimeApprovalRow,
  expected: {
    toolId:     string;
    action:     ToolActionGroup;
    argsHash:   string;
    runContext: RunContext;
    chatId:     string;
  },
): boolean {
  const payload = isRecord(approval.payloadJson) ? approval.payloadJson : {};
  const meta = isRecord(approval.metadataJson) ? approval.metadataJson : {};

  const expectedDepartmentId = expected.runContext.departmentId ? String(expected.runContext.departmentId) : null;

  return approval.toolId === expected.toolId
    && approval.actionGroup === expected.action
    && approval.requestedBy === String(expected.runContext.userId)
    && payload['toolId'] === expected.toolId
    && payload['action'] === expected.action
    && payload['argsHash'] === expected.argsHash
    && meta['requesterId'] === String(expected.runContext.userId)
    && meta['chatId'] === expected.chatId
    && (meta['departmentId'] ?? null) === expectedDepartmentId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
