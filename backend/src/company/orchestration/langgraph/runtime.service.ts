import type { ToolActionGroup } from '../../tools/tool-action-groups';
import { hitlActionService } from '../../state/hitl';
import type { HydratedStoredHitlAction } from '../../state/hitl';
import { createInitialRuntimeState, type RuntimeState } from './runtime.state';
import { runtimeApprovalRepository } from './runtime-approval.repository';
import { runtimeContextBuilder } from './runtime.context-builder';
import { runtimeConversationRepository } from './runtime-conversation.repository';
import { buildRuntimeConversationKey, buildRuntimeRawChannelKey } from './runtime.key';
import { runtimeRunRepository } from './runtime-run.repository';
import { runtimeShadowParityRepository } from './runtime-shadow-parity.repository';
import type {
  RuntimeActor,
  RuntimeChannel,
  RuntimeMessageKind,
  RuntimeMessageRole,
  RuntimeRunEntrypoint,
  RuntimeStopReason,
} from './runtime.types';

const mapActionGroupToHitlActionType = (actionGroup: ToolActionGroup): 'write' | 'update' | 'delete' | 'execute' => {
  if (actionGroup === 'update') return 'update';
  if (actionGroup === 'delete') return 'delete';
  if (actionGroup === 'execute') return 'execute';
  return 'write';
};

export class RuntimeService {
  async startRun(input: {
    companyId: string;
    channel: RuntimeChannel;
    entrypoint: RuntimeRunEntrypoint;
    actor: RuntimeActor;
    threadId?: string | null;
    chatId?: string | null;
    title?: string | null;
    incomingMessage?: {
      sourceMessageId?: string | null;
      text: string;
      attachments?: Array<Record<string, unknown>>;
    };
    traceJson?: Record<string, unknown>;
    metadataJson?: Record<string, unknown>;
    engineMode?: 'primary' | 'shadow';
    parentRunId?: string | null;
    maxSteps?: number;
  }): Promise<{
    conversationId: string;
    runId: string;
    state: RuntimeState;
  }> {
    const conversationKey = buildRuntimeConversationKey({
      channel: input.channel,
      threadId: input.threadId,
      chatId: input.chatId,
    });
    const rawChannelKey = buildRuntimeRawChannelKey({
      channel: input.channel,
      threadId: input.threadId,
      chatId: input.chatId,
    });

    const conversation = await runtimeConversationRepository.getOrCreate({
      companyId: input.companyId,
      channel: input.channel,
      channelConversationKey: conversationKey,
      rawChannelKey,
      createdByUserId: input.actor.linkedUserId ?? input.actor.userId ?? null,
      createdByEmail: input.actor.requesterEmail ?? null,
      title: input.title ?? null,
    });

    const run = await runtimeRunRepository.create({
      conversationId: conversation.id,
      parentRunId: input.parentRunId ?? null,
      channel: input.channel,
      entrypoint: input.entrypoint,
      engineMode: input.engineMode ?? 'primary',
      currentNode: 'load_run_context',
      traceJson: input.traceJson ?? null,
      metadataJson: input.metadataJson ?? null,
      maxSteps: input.maxSteps ?? 12,
    });

    if (input.incomingMessage?.text.trim()) {
      await runtimeConversationRepository.appendMessage({
        conversationId: conversation.id,
        runId: run.id,
        role: 'user',
        messageKind: 'chat',
        sourceChannel: input.channel,
        sourceMessageId: input.incomingMessage.sourceMessageId ?? null,
        dedupeKey: input.incomingMessage.sourceMessageId
          ? `user:${input.incomingMessage.sourceMessageId}`
          : `user:${run.id}`,
        contentText: input.incomingMessage.text,
        attachmentsJson: input.incomingMessage.attachments ?? null,
        visibility: 'channel',
      });
    }

    const context = await runtimeContextBuilder.build({
      conversationId: conversation.id,
      companyId: input.companyId,
      channel: input.channel,
      conversationKey,
      actor: input.actor,
      incomingText: input.incomingMessage?.text,
    });

    const historyMessages = await runtimeConversationRepository.listMessages(conversation.id, 20);
    const state = createInitialRuntimeState({
      run: {
        id: run.id,
        mode: (input.engineMode ?? 'primary'),
        channel: input.channel,
        entrypoint: input.entrypoint,
        currentNode: run.currentNode ?? 'load_run_context',
        stepIndex: run.stepCount,
        maxSteps: run.maxSteps,
      },
      conversation: {
        id: conversation.id,
        key: conversation.channelConversationKey,
        rawChannelKey: conversation.rawChannelKey,
        companyId: conversation.companyId,
        departmentId: context.department.departmentId,
        status: conversation.status as RuntimeState['conversation']['status'],
      },
      actor: input.actor,
      permissions: context.permissions,
      prompt: {
        baseSystemPrompt: context.systemPrompt,
        departmentName: context.department.departmentName,
        departmentRoleSlug: context.department.departmentRoleSlug,
        departmentPrompt: context.department.departmentPrompt,
        skillsMarkdown: context.department.skillsMarkdown,
        channelInstructions: input.channel === 'desktop'
          ? 'Desktop runtime adapter active.'
          : 'Lark runtime adapter active.',
        dateScope: context.dateScope,
      },
      history: {
        messages: historyMessages.map((message) => ({
          id: message.id,
          role: message.role as RuntimeMessageRole,
          messageKind: message.messageKind as RuntimeMessageKind,
          content: message.contentText ?? '',
          createdAt: message.createdAt.toISOString(),
          runId: message.runId ?? undefined,
          dedupeKey: message.dedupeKey ?? undefined,
        })),
        refs: context.refs,
      },
    });

    await runtimeRunRepository.createSnapshot({
      runId: run.id,
      stepIndex: 0,
      nodeName: 'load_run_context',
      stateJson: state as unknown as Record<string, unknown>,
    });

    return {
      conversationId: conversation.id,
      runId: run.id,
      state,
    };
  }

  recordMessage(input: {
    conversationId: string;
    runId?: string | null;
    sourceChannel: RuntimeChannel;
    role: RuntimeMessageRole;
    messageKind: RuntimeMessageKind;
    sourceMessageId?: string | null;
    dedupeKey?: string | null;
    contentText?: string | null;
    contentJson?: Record<string, unknown> | null;
    attachmentsJson?: Record<string, unknown> | Array<Record<string, unknown>> | null;
    toolCallJson?: Record<string, unknown> | null;
    toolResultJson?: Record<string, unknown> | null;
    visibility?: string;
  }) {
    return runtimeConversationRepository.appendMessage(input);
  }

  async requestApproval(input: {
    conversationId: string;
    runId: string;
    channel: RuntimeChannel;
    chatId: string;
    threadId?: string | null;
    executionId?: string | null;
    toolId: string;
    actionGroup: Extract<ToolActionGroup, 'create' | 'update' | 'delete' | 'send' | 'execute'>;
    summary: string;
    subject?: string | null;
    payloadJson: Record<string, unknown>;
    metadataJson?: Record<string, unknown> | null;
    requestedBy?: string | null;
    riskLevel?: string | null;
    idempotencyKey?: string | null;
    mirrorToLegacyHitl?: boolean;
  }) {
    const legacyAction = input.mirrorToLegacyHitl === false
      ? null
      : await hitlActionService.createPending({
        taskId: input.runId,
        actionType: mapActionGroupToHitlActionType(input.actionGroup),
        summary: input.summary,
        chatId: input.chatId,
        threadId: input.threadId ?? undefined,
        executionId: input.executionId ?? undefined,
        channel: input.channel,
        toolId: input.toolId,
        actionGroup: input.actionGroup,
        subject: input.subject ?? undefined,
        payload: input.payloadJson,
        metadata: input.metadataJson ?? undefined,
      });

    const approval = await runtimeApprovalRepository.create({
      conversationId: input.conversationId,
      runId: input.runId,
      externalActionId: legacyAction?.actionId ?? null,
      toolId: input.toolId,
      actionGroup: input.actionGroup,
      kind: 'tool_action',
      summary: input.summary,
      subject: input.subject ?? null,
      payloadJson: input.payloadJson,
      metadataJson: input.metadataJson ?? null,
      riskLevel: input.riskLevel ?? null,
      channel: input.channel,
      requestedBy: input.requestedBy ?? null,
      expiresAt: legacyAction ? new Date(legacyAction.expiresAt) : null,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    await runtimeConversationRepository.updateStatus(input.conversationId, 'waiting_for_approval');
    await runtimeRunRepository.update(input.runId, {
      status: 'waiting_for_approval',
      stopReason: 'needs_approval',
      currentNode: 'await_approval',
    });

    await runtimeConversationRepository.appendMessage({
      conversationId: input.conversationId,
      runId: input.runId,
      role: 'status',
      messageKind: 'approval_request',
      sourceChannel: input.channel,
      dedupeKey: approval.idempotencyKey ?? `approval:${approval.id}`,
      contentText: input.summary,
      toolResultJson: {
        approvalId: approval.id,
        externalActionId: approval.externalActionId,
        toolId: approval.toolId,
        actionGroup: approval.actionGroup,
      },
      visibility: 'internal',
    });

    return approval;
  }

  async mirrorLegacyApproval(input: {
    conversationId: string;
    runId: string;
    channel: RuntimeChannel;
    legacyAction: HydratedStoredHitlAction;
  }) {
    const existing = input.legacyAction.actionId
      ? await runtimeApprovalRepository.findByExternalActionId(input.legacyAction.actionId)
      : null;
    if (existing) {
      return existing;
    }

    const approval = await runtimeApprovalRepository.create({
      conversationId: input.conversationId,
      runId: input.runId,
      externalActionId: input.legacyAction.actionId,
      toolId: input.legacyAction.toolId ?? 'unknown_tool',
      actionGroup: input.legacyAction.actionGroup ?? 'execute',
      kind: 'tool_action',
      summary: input.legacyAction.summary,
      subject: input.legacyAction.subject ?? null,
      payloadJson: input.legacyAction.payload ?? {},
      metadataJson: input.legacyAction.metadata ?? null,
      channel: input.channel,
      requestedBy: undefined,
      expiresAt: input.legacyAction.expiresAt ? new Date(input.legacyAction.expiresAt) : null,
      idempotencyKey: `legacy:${input.legacyAction.actionId}`,
    });

    await runtimeConversationRepository.updateStatus(input.conversationId, 'waiting_for_approval');
    await runtimeRunRepository.update(input.runId, {
      status: 'waiting_for_approval',
      stopReason: 'needs_approval',
      currentNode: 'await_approval',
    });

    return approval;
  }

  async resolveApprovalFromLegacyAction(input: {
    externalActionId: string;
    decision: 'confirmed' | 'cancelled' | 'expired';
    approvedBy?: string | null;
    executionResultJson?: Record<string, unknown> | null;
  }) {
    const approval = await runtimeApprovalRepository.findByExternalActionId(input.externalActionId);
    if (!approval) {
      return null;
    }

    const now = new Date();
    const nextStatus = input.decision === 'confirmed'
      ? (input.executionResultJson ? 'executed' : 'confirmed')
      : input.decision;

    const updated = await runtimeApprovalRepository.updateStatus({
      approvalId: approval.id,
      status: nextStatus,
      approvedBy: input.approvedBy ?? null,
      approvedAt: input.decision === 'confirmed' ? now : null,
      rejectedAt: input.decision === 'cancelled' ? now : null,
      resolutionReason: `legacy_hitl_${input.decision}`,
      executionResultJson: input.executionResultJson ?? null,
    });

    await runtimeConversationRepository.appendMessage({
      conversationId: approval.conversationId,
      runId: approval.runId,
      role: 'status',
      messageKind: 'approval_resolution',
      sourceChannel: approval.channel as RuntimeChannel,
      dedupeKey: `approval_resolution:${approval.id}:${nextStatus}`,
      contentText: `Approval ${nextStatus}.`,
      toolResultJson: {
        approvalId: approval.id,
        decision: nextStatus,
      },
      visibility: 'internal',
    });

    if (nextStatus === 'cancelled' || nextStatus === 'expired') {
      await runtimeConversationRepository.updateStatus(approval.conversationId, 'active');
    }

    return updated;
  }

  async completeRun(input: {
    conversationId: string;
    runId: string;
    channel: RuntimeChannel;
    summary?: string;
    finalMessageId?: string | null;
  }) {
    await runtimeRunRepository.update(input.runId, {
      status: 'completed',
      stopReason: 'completed',
      finishedAt: new Date(),
      currentNode: 'persist_and_finish',
    });
    await runtimeConversationRepository.updateStatus(input.conversationId, 'completed');

    if (input.summary?.trim()) {
      await runtimeConversationRepository.appendMessage({
        conversationId: input.conversationId,
        runId: input.runId,
        role: 'assistant',
        messageKind: 'chat',
        sourceChannel: input.channel,
        dedupeKey: `assistant:${input.runId}`,
        contentText: input.summary,
        visibility: 'channel',
      });
    }
  }

  async failRun(input: {
    conversationId: string;
    runId: string;
    code: string;
    message: string;
    retriable: boolean;
    stopReason?: RuntimeStopReason;
  }) {
    await runtimeRunRepository.update(input.runId, {
      status: 'failed',
      stopReason: input.stopReason ?? 'tool_execution_failure',
      finishedAt: new Date(),
      currentNode: 'fail_run',
      errorJson: {
        code: input.code,
        message: input.message,
        retriable: input.retriable,
      },
    });
    await runtimeConversationRepository.updateStatus(input.conversationId, 'failed');
  }

  createShadowParityReport(input: {
    conversationId?: string | null;
    runId?: string | null;
    channel: RuntimeChannel;
    baselineSummary?: string | null;
    candidateSummary?: string | null;
    diffSummary?: string | null;
    metricsJson?: Record<string, unknown> | null;
  }) {
    return runtimeShadowParityRepository.create({
      conversationId: input.conversationId ?? null,
      runId: input.runId ?? null,
      channel: input.channel,
      baselineEngine: 'vercel',
      candidateEngine: 'langgraph',
      baselineSummary: input.baselineSummary ?? null,
      candidateSummary: input.candidateSummary ?? null,
      diffSummary: input.diffSummary ?? null,
      metricsJson: input.metricsJson ?? null,
    });
  }
}

export const runtimeService = new RuntimeService();
