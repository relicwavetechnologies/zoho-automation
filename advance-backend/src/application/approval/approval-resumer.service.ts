import type { RuntimeApprovalRepository } from '../../infrastructure/persistence/runtime-approval.repository';
import type { OrchestrationEngine } from '../orchestration/engine/core';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { ConversationRepoPort } from '../../infrastructure/persistence/conversation.repository';
import type { Logger } from '../../shared/logger';
import type { ApprovalGateService } from './approval-gate.service';
import type { ApprovalGrant } from '../../domain/orchestration/run-context';
import { buildApprovalResolutionCard } from './approval-card-builder';
import { asCompanyId, asUserId, asCorrelationId, asChatId, asMessageId, asDepartmentId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';

export interface ApprovalResumerDeps {
  approvalRepo:        RuntimeApprovalRepository;
  engine:              OrchestrationEngine;
  larkAdapter:         LarkChannelAdapter;
  channelIdentityRepo: ChannelIdentityRepoPort;
  conversationRepo:    ConversationRepoPort;
  approvalGate:        ApprovalGateService;
  logger:              Logger;
}

/**
 * Resumes execution after a manager approves or rejects an approval request.
 *
 * On approve:
 *   1. Adds the approval grant to runContext.approvalGrants
 *   2. Re-invokes the engine with the original user message + statusMessageId
 *   3. The gate sees the grant → tool executes → same bubble updates
 *
 * On reject:
 *   1. Injects a synthetic note so supervisor produces a graceful refusal
 *   2. Same bubble updates with the rejection explanation
 */
export class ApprovalResumerService {
  private readonly log: Logger;

  constructor(private readonly deps: ApprovalResumerDeps) {
    this.log = deps.logger.child({ service: 'approval-resumer' });
  }

  async resume(approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const approvalResult = await this.deps.approvalRepo.findById(approvalId);
    if (!approvalResult.ok || !approvalResult.value) {
      this.log.warn('resumer.approval_not_found', { approvalId });
      return;
    }

    const approval = approvalResult.value;
    if (approval.status !== 'approved' && approval.status !== 'rejected') {
      this.log.warn('resumer.approval_not_resolved', { approvalId, status: approval.status });
      return;
    }

    const meta = approval.metadataJson as Record<string, unknown>;
    const chatId        = meta['chatId']        as string | undefined;
    const requesterId   = meta['requesterId']   as string | undefined;
    const statusMsgId   = meta['statusMessageId'] as string | undefined;

    if (!chatId || !requesterId) {
      this.log.error('resumer.missing_metadata', { approvalId });
      return;
    }

    // Resolve requester identity for runContext.
    // Prefer the saved Lark open_id; fall back to userId lookup for older
    // approvals where requesterLarkOpenId wasn't persisted.
    const requesterLarkOpenIdMeta = meta['requesterLarkOpenId'] as string | undefined;
    const identityResult = requesterLarkOpenIdMeta
      ? await this.deps.channelIdentityRepo.resolveByLarkOpenId(requesterLarkOpenIdMeta)
      : await this.deps.channelIdentityRepo.resolveByUserId(requesterId);
    if (!identityResult.ok || !identityResult.value) {
      this.log.warn('resumer.identity_not_found', { approvalId, requesterId, requesterLarkOpenIdMeta });
      return;
    }
    const identity = identityResult.value;

    // Build the history synthetic note for the supervisor
    const payload       = approval.payloadJson as Record<string, unknown>;
    const originalArgs  = payload['args'];
    const toolId        = approval.toolId;
    const action        = approval.actionGroup;

    let userMessageForResume: string;
    if (decision === 'approved') {
      userMessageForResume = [
        `[SYSTEM: Manager approved the ${toolId}.${action} action.]`,
        `[APPROVAL GRANT ID: ${approvalId}]`,
        `Please proceed — execute the approved action now.`,
      ].join(' ');
    } else {
      userMessageForResume = [
        `[SYSTEM: Manager rejected the ${toolId}.${action} action.]`,
        `Please tell the user that their request was rejected by the manager and suggest alternatives.`,
      ].join(' ');
    }

    // Build approval grants for the run context
    const approvalGrants: ApprovalGrant[] = decision === 'approved'
      ? [{
          approvalId,
          toolId,
          action:   action as any,
          argsHash: (payload['argsHash'] as string) ?? '',
        }]
      : [];

    const correlationId = asCorrelationId(`resume-${approvalId}`);

    const requesterLarkOpenId = (meta['requesterLarkOpenId'] as string | undefined) ?? identity.larkOpenId;
    const runContext = {
      companyId:    asCompanyId(identity.companyId),
      userId:       asUserId(identity.userId),
      companyRole:  asCompanyRoleSlug(identity.aiRole),
      channel:      'lark' as const,
      traceId:      String(correlationId),
      approvalGrants,
      chatId,
      ...(requesterLarkOpenId    ? { userExternalId: requesterLarkOpenId } : {}),
      ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
    };

    const conversation = {
      channel:          'lark' as const,
      chatId:           asChatId(chatId),
      correlationId,
    };

    // Load last conversation turn for context (so supervisor isn't flying blind)
    const historyResult = await this.deps.conversationRepo.getHistory(chatId, 6);
    const lastUserMsg = historyResult.ok
      ? (historyResult.value.filter(t => t.role === 'user').at(-1)?.content ?? userMessageForResume)
      : userMessageForResume;

    // Pre-seed status coordinator so the same bubble gets updated
    if (statusMsgId) {
      this.deps.larkAdapter.restoreStatusCoordinator(String(correlationId), statusMsgId, chatId);
    }

    this.log.info('resumer.engine_invoked', { approvalId, decision, chatId });

    const result = await this.deps.engine.run({
      incoming: {
        channel:        'lark',
        messageId:      asMessageId(`resume-${approvalId}`),
        chatId:         asChatId(chatId),
        chatType:       'p2p',
        userExternalId: (meta['requesterLarkOpenId'] as string | undefined) ?? '',
        text:           userMessageForResume,
        attachments:    [],
        timestamp:      new Date().toISOString(),
        traceId:        correlationId,
        mentions:       [],
        mentionsSelf:   false,
        raw:            {},
      },
      runContext,
      conversation,
      channelAdapter:  this.deps.larkAdapter,
      approvalGate:    this.deps.approvalGate,
      ...(statusMsgId ? { existingStatusMessageId: statusMsgId } : {}),
    });

    if (!result.ok) {
      this.log.error('resumer.engine_failed', { approvalId, error: result.error.message });
      if (decision === 'approved') {
        await this.deps.approvalRepo.failApprovedExecution(approvalId, {
          status: 'engine_failed',
          message: result.error.message,
        });
      }
    } else {
      this.log.info('resumer.done', { approvalId, decision });
      const resultJson = {
        replyText:   result.value.finalReply.text.slice(0, 500),
        toolsCalled: result.value.toolsCalled,
      };
      if (decision === 'approved') {
        await this.deps.approvalRepo.completeApprovedExecution(approvalId, resultJson);
      } else {
        await this.deps.approvalRepo.persistResult(approvalId, resultJson);
      }
    }
  }
}
