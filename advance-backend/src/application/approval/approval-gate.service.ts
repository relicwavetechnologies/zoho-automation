import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PermissionResult } from '../permissions/permission.types';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { Logger } from '../../shared/logger';
import type { RuntimeApprovalRepository } from '../../infrastructure/persistence/runtime-approval.repository';
import type { ApprovalResolverService } from './approval-resolver.service';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { ApprovalDecision } from './approval.types';
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

export class ApprovalGateService {
  constructor(
    private readonly approvalRepo:    RuntimeApprovalRepository,
    private readonly resolver:        ApprovalResolverService,
    private readonly larkAdapter:     LarkChannelAdapter,
    private readonly logger:          Logger,
  ) {}

  async check(input: ApprovalGateInput): Promise<ApprovalDecision> {
    const { toolId, action, args, perm, runContext, chatId, argsSummary } = input;

    const policyResult = checkApprovalPolicy({ toolId, action, args, perm, runContext });

    if (!policyResult.required) {
      return { kind: 'allowed' };
    }

    // Approval required. Check idempotency — avoid duplicate cards on agent retry.
    const argsHash      = computeArgsHash(args);
    const idemKey       = computeIdempotencyKey(chatId, toolId, action, argsHash);
    const existingResult = await this.approvalRepo.findByIdempotencyKey(idemKey);

    if (existingResult.ok && existingResult.value) {
      const existing = existingResult.value;
      this.logger.info('approval.gate.idempotent', { approvalId: existing.id, toolId, action });
      return {
        kind:       'pending',
        approvalId: existing.id,
        message:    `This action is still waiting for manager approval (id: ${existing.id}). The request has already been sent — please wait.`,
      };
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
    if (String(runContext.userId) === manager.userId) {
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
    if (sendResult.ok) {
      // Persist the card message ID so the webhook can update it later
      await this.approvalRepo.setDecisionMessageId(approval.id, sendResult.value.messageId);
    } else {
      this.logger.warn('approval.gate.card_send_failed', {
        approvalId: approval.id,
        error:      sendResult.error.message,
      });
    }

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
}
