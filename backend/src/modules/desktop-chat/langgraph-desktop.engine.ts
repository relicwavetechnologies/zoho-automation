import { randomUUID } from 'crypto';

import { generateText, stepCountIs, streamText } from 'ai';
import type { Request, Response } from 'express';

import config from '../../config';
import { HttpException } from '../../core/http-exception';
import { executionService } from '../../company/observability';
import {
  desktopRuntimeAdapter,
  runtimeConversationRepository,
  runtimeLoopGuards,
  runtimeRunRepository,
  runtimeService,
  type RuntimeClassificationResult,
  type RuntimeDeliveryEnvelope,
  type RuntimeEvidenceItem,
  type RuntimeState,
} from '../../company/orchestration/langgraph';
import {
  buildClassifierPrompt,
  buildDeterministicSynthesis,
  buildInputMessages,
  buildReadOnlyRuntimeContext,
  buildResearchSystemPrompt,
  buildSynthesisTextPrompt,
  collectEvidenceFromToolOutput,
  findPendingApproval,
  selectToolFamilies,
  shouldDelegateToCompatibility,
  summarizeGraphText,
} from '../../company/orchestration/langgraph/core/runtime';
import {
  appendDesktopTextBlock,
  appendDesktopThinkingBlock,
  ensureDesktopThinkingBlock,
  sendDesktopSseEvent,
  type DesktopPersistedContentBlock,
  type DesktopUiEventType,
} from '../../company/orchestration/langgraph/adapters/desktop/stream-translator';
import {
  buildDesktopConversationKey,
  buildDesktopConversationRefsContext,
  buildPersistedConversationRefs,
  collectRecentAttachedFiles,
  mapDesktopHistoryToMessages,
} from '../../company/orchestration/langgraph/adapters/desktop/thread-history';
import { GraphToolFacade } from '../../company/orchestration/langgraph/graph-tool-facade';
import { resolveRouteContract } from '../../company/orchestration/langgraph/route-contract';
import { resolveVercelLanguageModel } from '../../company/orchestration/vercel/model-factory';
import type { PendingApprovalAction, VercelToolEnvelope } from '../../company/orchestration/vercel/types';
import { conversationMemoryStore } from '../../company/state/conversation/conversation-memory.store';
import { logger } from '../../utils/logger';
import { desktopThreadsService } from '../desktop-threads/desktop-threads.service';
import type { MemberSessionDTO } from '../member-auth/member-auth.service';
import { actSchema, sendSchema } from './desktop-chat.schemas';

type DesktopWorkspaceAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string };

type RemoteApprovalAction = {
  kind: 'tool_action';
  approvalId?: string;
  toolId: string;
  actionGroup: 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute';
  operation: string;
  title: string;
  summary: string;
  subject?: string;
  explanation?: string;
};

const isBareContinuationMessage = (message?: string): boolean => {
  const value = message?.trim().toLowerCase();
  if (!value) return false;
  return ['continue', 'go on', 'carry on', 'proceed', 'keep going', 'retry'].includes(value);
};

const buildContinuationHint = (message?: string): string | null => {
  if (!isBareContinuationMessage(message)) return null;
  return 'The latest user message is a continuation request. Continue the latest active user-requested task in this conversation, and prefer the most recent topic over older abandoned work.';
};

const buildRuntimeActor = (session: MemberSessionDTO) => ({
  userId: session.userId,
  linkedUserId: session.userId,
  requesterEmail: session.email ?? undefined,
  aiRole: session.aiRole ?? session.role,
  larkTenantKey: session.larkTenantKey ?? undefined,
  larkOpenId: session.larkOpenId ?? undefined,
  larkUserId: session.larkUserId ?? undefined,
});

const resolveLanggraphDesktopModel = async (mode: 'fast' | 'high') => {
  const resolved = await resolveVercelLanguageModel(mode);
  return {
    ...resolved,
    thinkingLevel: 'minimal' as const,
  };
};

const appendEventSafe = async (input: Parameters<typeof executionService.appendEvent>[0]) => {
  try {
    await executionService.appendEvent(input);
  } catch (error) {
    logger.warn('langgraph.desktop.execution.event.failed', {
      executionId: input.executionId,
      eventType: input.eventType,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
};

const persistUiEvent = async (
  executionId: string,
  type: DesktopUiEventType,
  data: unknown,
) => {
  const phase = type === 'thinking' || type === 'thinking_token'
    ? 'planning'
    : type === 'action'
      ? 'control'
    : type === 'text' || type === 'done'
      ? 'delivery'
      : type === 'error'
        ? 'error'
        : 'tool';

  await appendEventSafe({
    executionId,
    phase,
    eventType: `ui.${type}`,
    actorType: type === 'text' || type === 'done'
      ? 'delivery'
      : type === 'thinking' || type === 'thinking_token'
        ? 'model'
        : type === 'error' || type === 'action'
          ? 'system'
          : 'tool',
    actorKey: 'langgraph',
    title: `UI event: ${type}`,
    summary: summarizeGraphText(typeof data === 'string' ? data : JSON.stringify(data), 600),
    status: type === 'error' ? 'failed' : type === 'activity' ? 'running' : type === 'action' ? 'pending' : 'done',
    payload: typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : { value: data as unknown },
  });
};

const startExecutionRun = async (input: {
  executionId: string;
  threadId: string;
  messageId: string;
  session: MemberSessionDTO;
  mode: 'fast' | 'high';
  message: string;
}) => {
  await executionService.startRun({
    id: input.executionId,
    companyId: input.session.companyId,
    userId: input.session.userId,
    channel: 'desktop',
    entrypoint: 'desktop_send',
    requestId: input.executionId,
    threadId: input.threadId,
    chatId: input.threadId,
    messageId: input.messageId,
    mode: input.mode,
    agentTarget: 'langgraph',
    latestSummary: summarizeGraphText(input.message),
  });
};

const completeExecutionRun = async (executionId: string, summary: string) => {
  await executionService.completeRun({
    executionId,
    latestSummary: summarizeGraphText(summary, 400),
  });
};

const failExecutionRun = async (executionId: string, errorMessage: string) => {
  await executionService.failRun({
    executionId,
    latestSummary: summarizeGraphText(errorMessage, 400),
    errorCode: 'langgraph_desktop_failed',
    errorMessage,
  });
};

const mapPendingApprovalAction = (action: PendingApprovalAction): DesktopWorkspaceAction | RemoteApprovalAction => {
  switch (action.kind) {
    case 'run_command':
      return { kind: 'run_command', command: action.command };
    case 'write_file':
      return { kind: 'write_file', path: action.path, content: action.content };
    case 'create_directory':
      return { kind: 'mkdir', path: action.path };
    case 'delete_path':
      return { kind: 'delete_path', path: action.path };
    case 'tool_action':
      return {
        kind: 'tool_action',
        approvalId: action.approvalId,
        toolId: action.toolId,
        actionGroup: action.actionGroup,
        operation: action.operation,
        title: action.title,
        summary: action.summary,
        subject: action.subject,
        explanation: action.explanation,
      };
  }
};

const buildDesktopAdditionalInstructions = (input: {
  threadId: string;
  workspace?: { name: string; path: string };
  latestUserMessage?: string;
}): string => {
  const conversationRefsContext = buildDesktopConversationRefsContext(buildDesktopConversationKey(input.threadId));
  const parts = [
    'Desktop channel: preserve the current desktop response contract and prefer concise user-facing wording.',
    input.workspace ? `Open workspace name: ${input.workspace.name}.\nOpen workspace root: ${input.workspace.path}.` : '',
    input.workspace ? 'References like "this repo" or "this workspace" refer to that local root.' : '',
    conversationRefsContext ?? '',
    buildContinuationHint(input.latestUserMessage) ?? '',
  ].filter(Boolean);
  return parts.join('\n\n');
};

const buildSynthesisInput = (input: {
  message: string;
  classification: RuntimeClassificationResult;
  evidence: RuntimeEvidenceItem[];
  draft: string;
}): string => [
  `Original request: ${input.message}`,
  `Intent: ${input.classification.intent}`,
  `Draft answer: ${input.draft}`,
  `Evidence: ${input.evidence.slice(0, 8).map((entry, index) => `${index + 1}. ${entry.summary}`).join(' | ') || 'none'}`,
].join('\n');

const buildApprovalEnvelope = (input: {
  state: RuntimeState;
  summary: string;
  approvalId?: string;
}): RuntimeDeliveryEnvelope => ({
  channel: 'desktop',
  payloadType: 'approval',
  text: input.summary,
  dedupeKey: `approval:${input.state.run.id}:${input.approvalId ?? 'local'}`,
  metadata: desktopRuntimeAdapter.buildApprovalPayload({
    runId: input.state.run.id,
    conversationId: input.state.conversation.id,
    approvalId: input.approvalId ?? 'local_action',
    summary: input.summary,
  }),
});

const buildFinalEnvelope = (input: {
  state: RuntimeState;
  text: string;
}): RuntimeDeliveryEnvelope => ({
  channel: 'desktop',
  payloadType: 'final',
  text: input.text,
  dedupeKey: `final:${input.state.run.id}`,
  metadata: desktopRuntimeAdapter.buildFinalPayload({
    runId: input.state.run.id,
    conversationId: input.state.conversation.id,
    text: input.text,
    dedupeKey: `final:${input.state.run.id}`,
  }),
});

const persistNodeState = async (state: RuntimeState, nodeName: string) => {
  state.run.currentNode = nodeName;
  state.run.stepIndex += 1;
  state.diagnostics.nodeTransitionCount = state.diagnostics.nodeTransitionCount ?? {};
  state.diagnostics.nodeTransitionCount[nodeName] = (state.diagnostics.nodeTransitionCount[nodeName] ?? 0) + 1;

  await runtimeRunRepository.update(state.run.id, {
    currentNode: nodeName,
    stepCount: state.run.stepIndex,
  });
  await runtimeRunRepository.createSnapshot({
    runId: state.run.id,
    stepIndex: state.run.stepIndex,
    nodeName,
    stateJson: state as unknown as Record<string, unknown>,
  });
};

const markCompatibilityBlocked = async (input: {
  conversationId: string;
  runId: string;
  state: RuntimeState;
  reason: string;
  executionId: string;
}) => {
  input.state.plan = {
    kind: 'compatibility_blocked',
    reason: input.reason,
    steps: ['compat.blocked'],
  };
  input.state.execution = {
    steps: [],
  };
  await persistNodeState(input.state, 'compat.blocked');
  await runtimeRunRepository.update(input.runId, {
    status: 'failed',
    stopReason: 'policy_blocked',
    currentNode: 'compat.blocked',
    finishedAt: new Date(),
    metadataJson: {
      reason: input.reason,
      executionId: input.executionId,
    },
  });
  await runtimeConversationRepository.updateStatus(input.conversationId, 'active');
  await runtimeService.createShadowParityReport({
    conversationId: input.conversationId,
    runId: input.runId,
    channel: 'desktop',
    baselineSummary: null,
    candidateSummary: null,
    diffSummary: input.reason,
    metricsJson: {
      blocked: true,
      reason: input.reason,
    },
  });
};

export class LanggraphDesktopEngine {
  async stream(req: Request, res: Response, session: MemberSessionDTO): Promise<void> {
    const threadId = req.params.threadId;
    const { message, attachedFiles, workspace, mode, executionId: requestedExecutionId } = sendSchema.parse(req.body);
    const executionId = requestedExecutionId ?? randomUUID();
    const messageId = randomUUID();
    const conversationKey = buildDesktopConversationKey(threadId);
    req.body = {
      ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
      executionId,
    };

    logger.info('langgraph.desktop.stream.entry', {
      executionId,
      threadId,
      companyId: session.companyId,
      userId: session.userId,
      mode,
      messageLength: message.trim().length,
      attachedFileCount: attachedFiles.length,
      workspacePath: workspace?.path ?? null,
      configuredEngine: config.ORCHESTRATION_ENGINE,
    });

    const started = await runtimeService.startRun({
      companyId: session.companyId,
      channel: 'desktop',
      entrypoint: 'desktop_send',
      actor: buildRuntimeActor(session),
      threadId,
      chatId: threadId,
      incomingMessage: {
        sourceMessageId: messageId,
        text: message,
        attachments: attachedFiles,
      },
      traceJson: {
        executionId,
        mode,
        workspacePath: workspace?.path ?? null,
      },
      metadataJson: {
        origin: 'desktop_send',
      },
    });

    try {
      const state = started.state;
      logger.info('langgraph.desktop.history.load.start', {
        executionId,
        threadId,
      });
      const { messages: historyMessages, history } = await mapDesktopHistoryToMessages(threadId, session);
      logger.info('langgraph.desktop.history.load.completed', {
        executionId,
        threadId,
        historyMessageCount: historyMessages.length,
        persistedMessageCount: history.length,
      });

      const classifierModel = await resolveLanggraphDesktopModel(mode);
      logger.info('langgraph.desktop.classifier.start', {
        executionId,
        threadId,
        mode,
        effectiveModelId: classifierModel.effectiveModelId,
        thinkingLevel: classifierModel.thinkingLevel,
      });
      const classifierOutput = await generateText({
        model: classifierModel.model,
        system: 'Return JSON only.',
        prompt: buildClassifierPrompt(message),
        temperature: 0,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: false,
              thinkingLevel: classifierModel.thinkingLevel,
            },
          },
        },
      }).catch((error) => {
        logger.warn('langgraph.desktop.classifier.failed', {
          executionId,
          threadId,
          error: error instanceof Error ? error.message : 'unknown_classifier_error',
        });
        return null;
      });
      logger.info('langgraph.desktop.classifier.completed', {
        executionId,
        threadId,
        hadStructuredOutput: Boolean(classifierOutput?.text?.trim()),
      });

      const routeContract = resolveRouteContract({
        rawLlmOutput: classifierOutput?.text ?? null,
        messageText: message,
      });

      logger.info('langgraph.desktop.route.resolved', {
        executionId,
        threadId,
        intent: routeContract.route.intent,
        retrievalMode: routeContract.route.retrievalMode,
        complexity: routeContract.route.complexity,
        freshnessNeed: routeContract.route.freshnessNeed,
        risk: routeContract.route.risk,
        source: routeContract.source,
        fallbackReasonCode: routeContract.fallbackReasonCode ?? null,
      });

      state.classification = {
        intent: routeContract.route.intent,
        complexity: routeContract.route.complexity,
        freshnessNeed: routeContract.route.freshnessNeed,
        risk: routeContract.route.risk,
        domains: routeContract.route.domains,
        source: routeContract.source,
        fallbackReasonCode: routeContract.fallbackReasonCode,
      };
      await persistNodeState(state, 'route.classify');

      state.diagnostics.retrievalRouteCount = state.diagnostics.retrievalRouteCount ?? {};
      state.diagnostics.retrievalRouteCount[routeContract.route.retrievalMode] =
        (state.diagnostics.retrievalRouteCount[routeContract.route.retrievalMode] ?? 0) + 1;
      state.retrieval = {
        mode: routeContract.route.retrievalMode,
        rationale: routeContract.source === 'model'
          ? 'Classifier supplied retrieval mode.'
          : `Heuristic route for ${routeContract.route.intent}.`,
        source: routeContract.source === 'model' ? 'model' : 'heuristic_fallback',
        query: message,
        toolFamilies: [],
      };
      await persistNodeState(state, 'policy.gate');
      await persistNodeState(state, 'route.retrieval');

      logger.info('langgraph.desktop.compatibility.check', {
        executionId,
        threadId,
        routeIntent: routeContract.route.intent,
        retrievalMode: routeContract.route.retrievalMode,
      });
      const compatibilityReason = shouldDelegateToCompatibility({
        classification: state.classification,
        retrieval: state.retrieval,
        planSteps: [],
      });

      if (compatibilityReason) {
        const errorMessage = `LangGraph blocked this desktop request because it would have fallen back to the Vercel compatibility path. Reason: ${compatibilityReason}`;
        logger.warn('langgraph.desktop.path.compatibility_blocked', {
          executionId,
          threadId,
          reason: compatibilityReason,
          routeIntent: routeContract.route.intent,
          retrievalMode: routeContract.route.retrievalMode,
          blockedFallbackEngine: 'vercel',
        });
        await markCompatibilityBlocked({
          conversationId: started.conversationId,
          runId: started.runId,
          state,
          reason: compatibilityReason,
          executionId,
        });
        await runtimeService.failRun({
          conversationId: started.conversationId,
          runId: started.runId,
          code: 'langgraph_compatibility_blocked',
          message: errorMessage,
          retriable: false,
          stopReason: 'policy_blocked',
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        sendDesktopSseEvent(res, 'error', {
          message: errorMessage,
          code: 'langgraph_compatibility_blocked',
        });
        sendDesktopSseEvent(res, 'done', {
          executionId,
          pendingApproval: null,
          actionIssued: false,
        });
        res.end();
        return;
      }

      await startExecutionRun({
        executionId,
        threadId,
        messageId,
        session,
        mode,
        message,
      });
      await appendEventSafe({
        executionId,
        phase: 'request',
        eventType: 'execution.started',
        actorType: 'system',
        actorKey: 'langgraph',
        title: 'LangGraph desktop execution started',
        summary: summarizeGraphText(message),
        status: 'running',
        payload: { threadId, mode },
      });
      logger.info('langgraph.desktop.execution.bootstrapped', {
        executionId,
        threadId,
        runId: started.runId,
        conversationId: started.conversationId,
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      let uiEventQueue = Promise.resolve();
      const queueUiEvent = (type: DesktopUiEventType, data: unknown): void => {
        uiEventQueue = uiEventQueue.then(() => persistUiEvent(executionId, type, data)).catch(() => undefined);
      };

      await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'user',
        message,
        attachedFiles.length > 0 ? { attachedFiles } : undefined,
      );
      conversationMemoryStore.addUserMessage(conversationKey, messageId, message);
      logger.info('langgraph.desktop.user_message.persisted', {
        executionId,
        threadId,
        messageId,
        attachedFileCount: attachedFiles.length,
      });

      const mergedAttachments = new Map<string, typeof attachedFiles[number]>();
      for (const file of collectRecentAttachedFiles(history)) {
        mergedAttachments.set(file.fileAssetId, file);
      }
      for (const file of attachedFiles) {
        mergedAttachments.set(file.fileAssetId, file);
      }
      logger.info('langgraph.desktop.attachments.merged', {
        executionId,
        threadId,
        mergedAttachmentCount: mergedAttachments.size,
      });

      let persistedBlocks: DesktopPersistedContentBlock[] = [];
      const runtime = buildReadOnlyRuntimeContext({
        state,
        threadId,
        chatId: threadId,
        executionId,
        sourceUserId: session.userId,
        mode,
        workspace,
      });
      logger.info('langgraph.desktop.runtime.context_ready', {
        executionId,
        threadId,
        workspacePath: workspace?.path ?? null,
        mode,
      });
      const selectedFamilies = selectToolFamilies({
        classification: state.classification,
        retrieval: state.retrieval,
      });
      logger.info('langgraph.desktop.path.direct', {
        executionId,
        threadId,
        routeIntent: routeContract.route.intent,
        retrievalMode: routeContract.route.retrievalMode,
        toolFamilies: selectedFamilies,
      });
      state.retrieval.toolFamilies = selectedFamilies;
      state.plan = {
        kind: 'tool_loop',
        steps: ['research.execute', 'synthesis.compose', 'deliver.response'],
      };
      state.execution = { steps: [] };
      await persistNodeState(state, 'plan_gate');

      const toolIndexByActivityId = new Map<string, number>();
      const evidence: RuntimeEvidenceItem[] = [];
      const executionSteps = state.execution.steps;
      const facade = new GraphToolFacade(runtime, {
        onToolStart: async (toolName, activityId, title, toolInput) => {
          const inputGuard = runtimeLoopGuards.registerToolCall(state.diagnostics, toolName, toolInput ?? {});
          if (inputGuard.blocked) {
            throw new Error(`Tool loop guard triggered for ${toolName}.`);
          }

          toolIndexByActivityId.set(activityId, executionSteps.length);
          executionSteps.push({
            id: activityId,
            toolName,
            actionGroup: 'read',
            status: 'running',
            summary: title,
            input: toolInput,
          });

          sendDesktopSseEvent(res, 'activity', {
            id: activityId,
            name: toolName,
            label: title,
            icon: 'tool',
          });
          queueUiEvent('activity', {
            id: activityId,
            name: toolName,
            label: title,
            icon: 'tool',
          });
          persistedBlocks = [
            ...persistedBlocks,
            { type: 'tool', id: activityId, name: toolName, label: title, icon: 'tool', status: 'running' },
          ];

          await runtimeConversationRepository.appendMessage({
            conversationId: state.conversation.id,
            runId: state.run.id,
            role: 'tool',
            messageKind: 'tool_call',
            sourceChannel: 'desktop',
            dedupeKey: `tool_call:${state.run.id}:${activityId}`,
            contentText: title,
            toolCallJson: {
              toolName,
              input: toolInput ?? null,
            },
            visibility: 'internal',
          });
          await appendEventSafe({
            executionId,
            phase: 'tool',
            eventType: 'tool.started',
            actorType: 'tool',
            actorKey: toolName,
            title,
            status: 'running',
          });
        },
        onToolFinish: async (toolName, activityId, title, output) => {
          const index = toolIndexByActivityId.get(activityId);
          if (index !== undefined && executionSteps[index]) {
            executionSteps[index] = {
              ...executionSteps[index],
              status: output.pendingApprovalAction ? 'approval_required' : output.success ? 'completed' : 'failed',
              summary: output.summary,
              output: (output.fullPayload ?? output.keyData) as Record<string, unknown> | undefined,
              citations: (output.citations ?? []) as Array<Record<string, unknown>>,
            };
          }

          evidence.push(...collectEvidenceFromToolOutput(toolName, {
            summary: output.summary,
            fullPayload: output.fullPayload ?? output.keyData,
            citations: output.citations ?? [],
          }));

          sendDesktopSseEvent(res, 'activity_done', {
            id: activityId,
            name: toolName,
            label: title,
            icon: output.success ? 'tool' : 'x-circle',
            resultSummary: output.summary,
          });
          queueUiEvent('activity_done', {
            id: activityId,
            name: toolName,
            label: title,
            icon: output.success ? 'tool' : 'x-circle',
            resultSummary: output.summary,
          });
          persistedBlocks = persistedBlocks.map((block) =>
            block.type === 'tool' && block.id === activityId
              ? {
                ...block,
                name: toolName,
                label: title,
                icon: output.success ? 'tool' : 'x-circle',
                status: output.success ? 'done' : 'failed',
                resultSummary: output.summary,
              }
              : block,
          );

          await runtimeConversationRepository.appendMessage({
            conversationId: state.conversation.id,
            runId: state.run.id,
            role: 'tool',
            messageKind: 'tool_result',
            sourceChannel: 'desktop',
            dedupeKey: `tool_result:${state.run.id}:${activityId}`,
            contentText: output.summary,
            toolResultJson: {
              toolName,
              success: output.success,
              summary: output.summary,
              citations: output.citations ?? [],
            },
            visibility: 'internal',
          });
          await appendEventSafe({
            executionId,
            phase: output.pendingApprovalAction ? 'control' : 'tool',
            eventType: output.pendingApprovalAction ? 'control.requested' : 'tool.completed',
            actorType: output.pendingApprovalAction ? 'system' : 'tool',
            actorKey: output.pendingApprovalAction ? output.pendingApprovalAction.kind : toolName,
            title,
            summary: summarizeGraphText(output.summary, 600),
            status: output.pendingApprovalAction ? 'pending' : output.success ? 'done' : 'failed',
            payload: {
              success: output.success,
              pendingApprovalAction: output.pendingApprovalAction ?? null,
            },
          });
        },
      });

      const researchTools = facade.selectFamilies(selectedFamilies);
      const inputMessages = await buildInputMessages({
        state,
        messageText: message,
        runtime,
        attachedFiles: Array.from(mergedAttachments.values()),
        historyMessages: message.trim()
          ? [...historyMessages, { role: 'user', content: message }]
          : historyMessages,
      });
      const researchModel = await resolveLanggraphDesktopModel(mode);
      logger.info('langgraph.desktop.research.start', {
        executionId,
        threadId,
        toolFamilies: selectedFamilies,
        inputMessageCount: inputMessages.length,
        effectiveModelId: researchModel.effectiveModelId,
        thinkingLevel: researchModel.thinkingLevel,
      });
      const researchResult = await generateText({
        model: researchModel.model,
        system: buildResearchSystemPrompt({
          state,
          classification: state.classification,
          retrieval: state.retrieval,
          toolFamilies: selectedFamilies,
          additionalInstructions: buildDesktopAdditionalInstructions({
            threadId,
            workspace,
            latestUserMessage: message,
          }),
        }),
        messages: inputMessages,
        tools: researchTools,
        temperature: config.OPENAI_TEMPERATURE,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: researchModel.thinkingLevel,
            },
          },
        },
        stopWhen: [stepCountIs(12)],
      });
      logger.info('langgraph.desktop.research.completed', {
        executionId,
        threadId,
        researchTextLength: researchResult.text.trim().length,
        stepCount: researchResult.steps.length,
        evidenceCount: evidence.length,
      });

      state.evidence = evidence;
      await persistNodeState(state, 'research.execute');

      const researchSteps = researchResult.steps as Array<{ toolResults?: Array<{ output?: unknown }> }>;
      const pendingApproval = findPendingApproval(researchSteps);
      logger.info('langgraph.desktop.approval.scan.completed', {
        executionId,
        threadId,
        pendingApproval: Boolean(pendingApproval),
      });
      if (pendingApproval) {
        const pendingAction = mapPendingApprovalAction(pendingApproval);
        const approvalSummary = pendingAction.kind === 'tool_action'
          ? pendingAction.summary
          : pendingAction.kind === 'run_command'
            ? pendingAction.command
            : pendingAction.kind;

        executionSteps.push({
          id: randomUUID(),
          toolName: pendingApproval.toolId ?? pendingApproval.kind,
          actionGroup: pendingApproval.actionGroup ?? 'execute',
          status: 'approval_required',
          summary: approvalSummary,
        });
        const approvalEnvelope = buildApprovalEnvelope({
          state,
          summary: approvalSummary,
          approvalId: pendingApproval.kind === 'tool_action' ? pendingApproval.approvalId : undefined,
        });
        const approvalDeliveryCheck = runtimeLoopGuards.registerDelivery(
          state.diagnostics,
          state.run.channel,
          approvalEnvelope.dedupeKey,
        );
        if (!approvalDeliveryCheck.blocked) {
          state.delivery.sentDedupeKeys.push(approvalEnvelope.dedupeKey);
          state.delivery.outbox.push(approvalEnvelope);
        }
        await runtimeRunRepository.update(state.run.id, {
          status: 'waiting_for_approval',
          stopReason: 'needs_approval',
          currentNode: 'await_approval',
        });
        await runtimeConversationRepository.updateStatus(state.conversation.id, 'waiting_for_approval');
        await persistNodeState(state, 'await_approval');

        sendDesktopSseEvent(res, 'action', { action: pendingAction, executionId });
        queueUiEvent('action', { action: pendingAction, executionId });

        const citations = researchSteps.flatMap((step) =>
          (step.toolResults ?? []).flatMap((toolResult) => {
            const output = toolResult.output as VercelToolEnvelope | undefined;
            return output?.citations ?? [];
          }));
        const conversationRefs = buildPersistedConversationRefs(conversationKey);
        const assistantMessage = await desktopThreadsService.addMessage(
          threadId,
          session.userId,
          'assistant',
          '',
          {
            executionId,
            contentBlocks: persistedBlocks,
            ...(citations.length > 0 ? { citations } : {}),
            ...(conversationRefs ? { conversationRefs } : {}),
          },
        );
        if (conversationRefs) {
          await runtimeConversationRepository.updateRefs(state.conversation.id, conversationRefs);
        }
        await appendEventSafe({
          executionId,
          phase: 'control',
          eventType: 'control.requested',
          actorType: 'system',
          actorKey: pendingApproval.kind,
          title: 'Approval requested',
          summary: summarizeGraphText(approvalSummary, 600),
          status: 'pending',
        });
        await runtimeService.createShadowParityReport({
          conversationId: started.conversationId,
          runId: started.runId,
          channel: 'desktop',
          baselineSummary: null,
          candidateSummary: null,
          diffSummary: 'approval_required',
          metricsJson: {
            approvalIssued: true,
            retrievalMode: state.retrieval.mode,
            toolFamilies: selectedFamilies,
          },
        });
        queueUiEvent('done', {
          executionId,
          pendingApproval,
          actionIssued: true,
        });
        logger.info('langgraph.desktop.awaiting_approval', {
          executionId,
          threadId,
          actionKind: pendingAction.kind,
          actionSummary: approvalSummary,
        });
        await uiEventQueue;
        sendDesktopSseEvent(res, 'done', {
          message: assistantMessage,
          executionId,
          pendingApproval,
          actionIssued: true,
        });
        res.end();
        return;
      }

      const deterministicFallback = buildDeterministicSynthesis({
        answerDraft: researchResult.text,
        evidence,
      });

      const synthesisModel = await resolveLanggraphDesktopModel(mode);
      logger.info('langgraph.desktop.synthesis.start', {
        executionId,
        threadId,
        effectiveModelId: synthesisModel.effectiveModelId,
        thinkingLevel: synthesisModel.thinkingLevel,
        deterministicFallbackLength: deterministicFallback.text.trim().length,
      });
      const synthesisResult = await streamText({
        model: synthesisModel.model,
        system: buildSynthesisTextPrompt({
          state,
          classification: state.classification,
          answerDraft: researchResult.text,
          evidence,
        }),
        prompt: buildSynthesisInput({
          message,
          classification: state.classification,
          evidence,
          draft: researchResult.text,
        }),
        temperature: 0,
        providerOptions: {
          google: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: synthesisModel.thinkingLevel,
            },
          },
        },
      });

      let streamedText = '';
      let sawThinking = false;
      for await (const part of synthesisResult.fullStream) {
        if (part.type === 'reasoning-start') {
          sawThinking = true;
          sendDesktopSseEvent(res, 'thinking', { text: '' });
          queueUiEvent('thinking', { text: '' });
          persistedBlocks = ensureDesktopThinkingBlock(persistedBlocks);
          continue;
        }

        if (part.type === 'reasoning-delta' && part.text) {
          if (!sawThinking) {
            sawThinking = true;
            sendDesktopSseEvent(res, 'thinking', { text: '' });
            queueUiEvent('thinking', { text: '' });
            persistedBlocks = ensureDesktopThinkingBlock(persistedBlocks);
          }
          sendDesktopSseEvent(res, 'thinking_token', part.text);
          queueUiEvent('thinking_token', part.text);
          persistedBlocks = appendDesktopThinkingBlock(persistedBlocks, part.text);
          continue;
        }

        if (part.type === 'text-delta' && part.text) {
          streamedText += part.text;
          sendDesktopSseEvent(res, 'text', part.text);
          queueUiEvent('text', part.text);
          persistedBlocks = appendDesktopTextBlock(persistedBlocks, part.text);
        }
      }

      const finalText = streamedText.trim() || deterministicFallback.text;
      logger.info('langgraph.desktop.synthesis.completed', {
        executionId,
        threadId,
        usedDeterministicFallback: !streamedText.trim(),
        finalTextLength: finalText.trim().length,
      });
      if (!streamedText.trim() && finalText.trim()) {
        sendDesktopSseEvent(res, 'text', finalText);
        queueUiEvent('text', finalText);
        persistedBlocks = appendDesktopTextBlock(persistedBlocks, finalText);
      }

      state.parity = {
        baselineEngine: 'vercel',
        candidateEngine: 'langgraph',
        diffSummary: state.classification.source === 'model'
          ? 'graph_desktop_model_routed'
          : 'graph_desktop_heuristic_routed',
        metrics: {
          retrievalMode: state.retrieval.mode,
          toolFamilies: selectedFamilies,
          evidenceCount: evidence.length,
        },
      };
      await persistNodeState(state, 'synthesis.compose');

      const citations = researchSteps.flatMap((step) =>
        (step.toolResults ?? []).flatMap((toolResult) => {
          const output = toolResult.output as VercelToolEnvelope | undefined;
          return output?.citations ?? [];
        }));
      const conversationRefs = buildPersistedConversationRefs(conversationKey);
      logger.info('langgraph.desktop.assistant_message.persist.start', {
        executionId,
        threadId,
        citationCount: citations.length,
        hasConversationRefs: Boolean(conversationRefs),
      });
      const assistantMessage = await desktopThreadsService.addMessage(
        threadId,
        session.userId,
        'assistant',
        finalText,
        {
          executionId,
          contentBlocks: persistedBlocks,
          ...(citations.length > 0 ? { citations } : {}),
          ...(conversationRefs ? { conversationRefs } : {}),
        },
      );
      conversationMemoryStore.addAssistantMessage(conversationKey, assistantMessage.id, finalText);
      if (conversationRefs) {
        await runtimeConversationRepository.updateRefs(state.conversation.id, conversationRefs);
      }
      logger.info('langgraph.desktop.assistant_message.persist.completed', {
        executionId,
        threadId,
        assistantMessageId: assistantMessage.id,
      });

      await appendEventSafe({
        executionId,
        phase: 'synthesis',
        eventType: 'synthesis.completed',
        actorType: 'agent',
        actorKey: 'langgraph',
        title: 'Generated assistant response',
        summary: summarizeGraphText(finalText, 600),
        status: 'done',
      });

      const finalDedupeKey = `final:${state.run.id}`;
      const deliveryCheck = runtimeLoopGuards.registerDelivery(state.diagnostics, state.run.channel, finalDedupeKey);
      if (!deliveryCheck.blocked) {
        state.delivery.sentDedupeKeys.push(finalDedupeKey);
        state.delivery.outbox.push(buildFinalEnvelope({ state, text: finalText }));
      }
      logger.info('langgraph.desktop.delivery.prepared', {
        executionId,
        threadId,
        blocked: deliveryCheck.blocked,
        dedupeKey: finalDedupeKey,
      });

      await persistNodeState(state, 'deliver.response');
      await runtimeService.createShadowParityReport({
        conversationId: started.conversationId,
        runId: started.runId,
        channel: 'desktop',
        baselineSummary: null,
        candidateSummary: finalText,
        diffSummary: state.parity?.diffSummary ?? null,
        metricsJson: state.parity?.metrics ?? null,
      });

      await runtimeService.completeRun({
        conversationId: started.conversationId,
        runId: started.runId,
        channel: 'desktop',
        summary: finalText,
      });
      await completeExecutionRun(executionId, finalText);
      await persistNodeState(state, 'persist_and_finish');
      logger.info('langgraph.desktop.execution.completed', {
        executionId,
        threadId,
        runId: started.runId,
        assistantMessageId: assistantMessage.id,
      });

      queueUiEvent('done', { executionId, pendingApproval: null, actionIssued: false });
      await uiEventQueue;
      sendDesktopSseEvent(res, 'done', {
        message: assistantMessage,
        executionId,
        pendingApproval: null,
        actionIssued: false,
      });
      res.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'LangGraph desktop stream failed';
      logger.error('langgraph.desktop.stream.failed', {
        executionId,
        threadId,
        error: errorMessage,
      });
      await runtimeService.failRun({
        conversationId: started.conversationId,
        runId: started.runId,
        code: 'langgraph_desktop_stream_failed',
        message: errorMessage,
        retriable: true,
        stopReason: 'tool_execution_failure',
      });
      await appendEventSafe({
        executionId,
        phase: 'error',
        eventType: 'execution.failed',
        actorType: 'system',
        actorKey: 'langgraph',
        title: 'LangGraph desktop stream failed',
        summary: summarizeGraphText(errorMessage),
        status: 'failed',
      });
      await failExecutionRun(executionId, errorMessage).catch(() => undefined);

      if (!res.headersSent) {
        logger.error('langgraph.desktop.stream.failure_blocked', {
          executionId,
          threadId,
          companyId: session.companyId,
          userId: session.userId,
          blockedFallbackEngine: 'vercel',
          reason: 'langgraph_stream_failed_without_vercel_fallback',
        });
        res.status(500).json({
          success: false,
          message: errorMessage,
          error: {
            code: 'langgraph_stream_failed',
            blockedFallbackEngine: 'vercel',
          },
        });
        return;
      }

      await persistUiEvent(executionId, 'error', { message: errorMessage });
      sendDesktopSseEvent(res, 'error', { message: errorMessage });
      res.end();
    }
  }

  async act(req: Request, res: Response, session: MemberSessionDTO) {
    const parsed = actSchema.parse(req.body ?? {});
    req.body = {
      ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
      executionId: parsed.executionId ?? randomUUID(),
    };
    logger.info('langgraph.desktop.act.fallback', {
      executionId: req.body.executionId,
      threadId: req.params.threadId,
      companyId: session.companyId,
      userId: session.userId,
      reason: 'langgraph_act_not_enabled_without_vercel_fallback',
    });
    throw new HttpException(409, 'LangGraph desktop act is not enabled while Vercel fallback is blocked.');
  }

  async streamAct(req: Request, res: Response, session: MemberSessionDTO): Promise<void> {
    const parsed = actSchema.parse(req.body ?? {});
    req.body = {
      ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
      executionId: parsed.executionId ?? randomUUID(),
    };
    logger.info('langgraph.desktop.act_stream.fallback', {
      executionId: req.body.executionId,
      threadId: req.params.threadId,
      companyId: session.companyId,
      userId: session.userId,
      reason: 'langgraph_act_stream_not_enabled_without_vercel_fallback',
    });
    throw new HttpException(409, 'LangGraph desktop action streaming is not enabled while Vercel fallback is blocked.');
  }
}

export const langgraphDesktopEngine = new LanggraphDesktopEngine();
