import { RequestContext } from '@mastra/core/di';

import config from '../../../config';
import { resolveChannelAdapter } from '../../channels';
import { channelIdentityRepository } from '../../channels/channel-identity.repository';
import { mastra } from '../../integrations/mastra';
import { buildMastraAgentRunOptions } from '../../integrations/mastra/mastra-model-control';
import { personalVectorMemoryService } from '../../integrations/vector';
import { logger } from '../../../utils/logger';
import { checkpointRepository } from '../../state/checkpoint';
import { conversationMemoryStore } from '../../state/conversation';
import { applyGenerationWordLimit } from '../../support/content-limits';
import { orchestratorService } from '../orchestrator.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { prisma } from '../../../utils/prisma';
import type { AiRole } from '../../tools/tool-registry';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';

// Maximum time (ms) we wait for the LLM agent to respond before aborting.
// Keep this shorter than any upstream HTTP gateway timeout.
const AGENT_GENERATE_TIMEOUT_MS = 50_000;
// Removed: ACK_GENERATE_TIMEOUT_MS – no longer calling LLM for acks
const PROGRESS_MIN_INITIAL_CHARS = 20;
const PROGRESS_MIN_UPDATE_DELTA_CHARS = 24;
const PROGRESS_MIN_UPDATE_INTERVAL_MS = 900;
const PROGRESS_MAX_BUFFER_CHARS = 160;
const HISTORY_CONTEXT_MESSAGE_LIMIT = 14;
const HISTORY_PREFIX_LIMIT = 12;
const PERSONAL_CONTEXT_LIMIT = 4;

const buildHistoryAwarePrompt = (
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  personalContext: Array<{ role?: string; content: string }>,
  currentMessageText: string,
): string => {
  const normalizedCurrent = currentMessageText.trim();
  const contextOnly = history.filter(
    (entry, index) =>
      !(index === history.length - 1 && entry.role === 'user' && entry.content.trim() === normalizedCurrent),
  );

  if (contextOnly.length === 0 && personalContext.length === 0) {
    return currentMessageText;
  }

  const sections: string[] = [];

  if (personalContext.length > 0) {
    sections.push(
      'Relevant personal memory from this same user in prior chats:',
      personalContext
        .slice(0, PERSONAL_CONTEXT_LIMIT)
        .map((entry) => `${entry.role === 'assistant' ? 'Assistant memory' : 'User memory'}: ${entry.content}`)
        .join('\n'),
      '',
    );
  }

  if (contextOnly.length > 0) {
    sections.push(
      'Conversation context from this same chat (most recent first-order history):',
      contextOnly
        .slice(-HISTORY_PREFIX_LIMIT)
        .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
        .join('\n'),
      '',
    );
  }

  return [
    ...sections,
    `Current user message: ${currentMessageText}`,
  ].join('\n');
};

/** Race an async value against a hard deadline. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

const isSentenceBoundaryChar = (char: string): boolean => char === '.' || char === '?' || char === '!' || char === '\n';

const normalizeAckText = (text: string): string => {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.length > 160 ? `${compact.slice(0, 157).trimEnd()}...` : compact;
};

export const findProgressFlushIndex = (text: string): number => {
  let boundaryIndex = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (isSentenceBoundaryChar(text[index])) {
      boundaryIndex = index + 1;
      while (boundaryIndex < text.length && /\s/.test(text[boundaryIndex])) {
        boundaryIndex += 1;
      }
    }
  }
  return boundaryIndex;
};

export const splitProgressBuffer = (
  text: string,
  options: {
    force?: boolean;
    intervalElapsed?: boolean;
    maxChars?: number;
  } = {},
): { flushText: string; remainder: string } | null => {
  if (!text) {
    return null;
  }

  if (options.force) {
    return {
      flushText: text,
      remainder: '',
    };
  }

  const boundaryIndex = findProgressFlushIndex(text);
  if (boundaryIndex > 0) {
    return {
      flushText: text.slice(0, boundaryIndex),
      remainder: text.slice(boundaryIndex),
    };
  }

  const maxChars = options.maxChars ?? PROGRESS_MAX_BUFFER_CHARS;
  if (text.length >= maxChars || options.intervalElapsed) {
    return {
      flushText: text,
      remainder: '',
    };
  }

  return null;
};

export class MastraOrchestrationEngine implements OrchestrationEngine {
  readonly id = 'mastra' as const;

  /**
   * Dedup map: messageId → in-flight execution promise.
   * Prevents the same incoming message from triggering multiple parallel agent runs
   * (which is what causes the repeated mcp.tools.list + duplicate tool calls in logs).
   */
  private readonly inFlight = new Map<string, Promise<OrchestrationExecutionResult>>();

  async buildTask(taskId: string, message: OrchestrationExecutionInput['message']) {
    const task = await orchestratorService.buildTask(taskId, message);
    return {
      ...task,
      orchestratorModel: 'mastra-sdk',
    };
  }

  async executeTask(input: OrchestrationExecutionInput): Promise<OrchestrationExecutionResult> {
    const { message } = input;
    const dedupKey = message.messageId;

    // ── Concurrent-request dedup ─────────────────────────────────────────────
    // If an identical messageId is already being processed, return the same
    // promise instead of spawning a second parallel agent run.  This is the
    // primary cause of the repeated mcp.tools.list + duplicate tool-call loop.
    const existing = this.inFlight.get(dedupKey);
    if (existing) {
      logger.warn('mastra.engine.dedup.skip', {
        messageId: dedupKey,
        taskId: input.task.taskId,
      });
      return existing;
    }

    const promise = this._runTask(input).finally(() => {
      this.inFlight.delete(dedupKey);
    });
    this.inFlight.set(dedupKey, promise);
    return promise;
  }

  private async _runTask(input: OrchestrationExecutionInput): Promise<OrchestrationExecutionResult> {
    const { task, message, latestCheckpoint } = input;

    // ── Card Action Intercept ────────────────────────────────────────────────
    // Lark sends card.action.trigger webhooks as a "message" with the text
    // "[Interactive Card Action] {...payload}". We short-circuit here so the
    // AI pipeline never sees the button click.
    if (message.text.startsWith('[Interactive Card Action]')) {
      try {
        const jsonStart = message.text.indexOf('{');
        const action = jsonStart >= 0
          ? (JSON.parse(message.text.slice(jsonStart)) as Record<string, unknown>)
          : {};
        const actionId = typeof action.id === 'string' ? action.id : undefined;
        const companyId = message.trace?.companyId ?? '';
        const channelAdapter = resolveChannelAdapter(message.channel);

        // ── User taps "Share this chat's knowledge" ──────────────────────────
        if (actionId === 'share_vectors') {
          const conversationKey = typeof action.conversationKey === 'string' ? action.conversationKey : '';
          const triggerMessageId = typeof action.triggerMessageId === 'string' ? action.triggerMessageId : undefined;
          const requesterUserId = message.userId;

          if (companyId && conversationKey && requesterUserId) {
            // 1. Create (or reuse) a pending VectorShareRequest in the DB.
            const existingPending = await prisma.vectorShareRequest.findFirst({
              where: { companyId, requesterUserId, conversationKey, status: 'pending' },
              orderBy: { createdAt: 'desc' },
            });
            const shareRequest = existingPending ?? await prisma.vectorShareRequest.create({
              data: { companyId, requesterUserId, conversationKey, status: 'pending' },
            });

            // 2. Immediately update the user's message to "pending" so they get feedback.
            if (triggerMessageId) {
              await channelAdapter.updateMessage({
                messageId: triggerMessageId,
                text: '_Share request submitted — pending administrator review._',
                correlationId: task.taskId,
                actions: [], // Remove the button; no double-clicks.
              });
            }

            // 3. Build a short conversation preview for the admin card.
            const previewDocs = await personalVectorMemoryService.getConversationPreview(
              companyId, requesterUserId, conversationKey,
            );

            // 4. Dispatch DM approval cards to all company admins with Lark OpenIDs.
            const admins = await channelIdentityRepository.findAdminsByCompany(companyId);
            const requesterName = requesterUserId;
            const adminCardText = [
              `**Vector Share Request**`,
              `*Requested by:* ${requesterName}`,
              '',
              `*Conversation preview:*`,
              previewDocs ? previewDocs : '_No preview available._',
            ].join('\n');

            await Promise.allSettled(
              admins.map((admin) =>
                channelAdapter.sendMessage({
                  chatId: admin.larkOpenId, // ou_ prefix → DM via open_id routing
                  text: adminCardText,
                  correlationId: task.taskId,
                  actions: [
                    {
                      id: 'admin_share_decision',
                      label: 'Approve',
                      value: { requestId: shareRequest.id, decision: 'approve' },
                      style: 'primary',
                    },
                    {
                      id: 'admin_share_decision',
                      label: 'Reject',
                      value: { requestId: shareRequest.id, decision: 'reject' },
                      style: 'danger',
                    },
                  ],
                }),
              ),
            );

            logger.info('mastra.engine.share_vectors.request.dispatched', {
              taskId: task.taskId,
              companyId,
              conversationKey,
              requestId: shareRequest.id,
              adminCount: admins.length,
            });
          }
        }

        // ── Admin taps Approve or Reject ─────────────────────────────────────
        if (actionId === 'admin_share_decision') {
          const requestId = typeof action.requestId === 'string' ? action.requestId : undefined;
          const decision = action.decision === 'approve' || action.decision === 'reject' ? action.decision : undefined;
          const adminMessageId = typeof action.adminMessageId === 'string' ? action.adminMessageId : undefined;

          if (requestId && decision) {
            const shareRow = await prisma.vectorShareRequest.findUnique({ where: { id: requestId } });

            if (shareRow && shareRow.status === 'pending') {
              if (decision === 'approve') {
                // Promote vectors in Postgres + Qdrant using the existing service.
                await personalVectorMemoryService.shareConversation({
                  companyId: shareRow.companyId,
                  requesterUserId: shareRow.requesterUserId,
                  conversationKey: shareRow.conversationKey,
                });
                await prisma.vectorShareRequest.update({
                  where: { id: requestId },
                  data: { status: 'approved', reviewedBy: message.userId, reviewedAt: new Date() },
                });
              } else {
                await prisma.vectorShareRequest.update({
                  where: { id: requestId },
                  data: { status: 'rejected', reviewedBy: message.userId, reviewedAt: new Date() },
                });
              }

              // Update the admin's card to reflect the decision.
              if (adminMessageId) {
                const confirmText = decision === 'approve'
                  ? '_Approved — knowledge is now shared company-wide._'
                  : '_Rejected — personal vectors remain private._';
                await channelAdapter.updateMessage({
                  messageId: adminMessageId,
                  text: confirmText,
                  correlationId: task.taskId,
                  actions: [], // Remove buttons after decision.
                });
              }

              logger.info('mastra.engine.admin_share_decision.completed', {
                taskId: task.taskId,
                requestId,
                decision,
              });
            }
          }
        }
      } catch (error) {
        logger.warn('mastra.engine.card_action.failed', {
          taskId: task.taskId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
      // Always return done — never feed card events to the AI.
      return {
        task,
        status: 'done',
        currentStep: 'action_complete',
        latestSynthesis: '',
        runtimeMeta: { engine: 'mastra', node: 'card_action', stepHistory: ['card_action'] },
      };
    }

    if (latestCheckpoint?.node === 'synthesis.complete') {
      const text =
        typeof latestCheckpoint.state.text === 'string'
          ? latestCheckpoint.state.text
          : 'Recovered from completed checkpoint';
      return {
        task,
        status: 'done',
        currentStep: 'synthesis.compose',
        latestSynthesis: text,
        runtimeMeta: {
          engine: 'mastra',
          node: 'synthesis.complete',
          stepHistory: ['mastra.request', 'synthesis.complete'],
        },
      };
    }

    await checkpointRepository.save(task.taskId, 'mastra.request', {
      channel: message.channel,
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: message.chatType,
      timestamp: message.timestamp,
      userId: message.userId,
      requestId: message.trace?.requestId,
      eventId: message.trace?.eventId,
      textHash: message.trace?.textHash,
      companyId: message.trace?.companyId,
      larkTenantKey: message.trace?.larkTenantKey,
    });

    logger.info('mastra.engine.request.start', {
      taskId: task.taskId,
      messageId: message.messageId,
      requestId: message.trace?.requestId,
      companyId: message.trace?.companyId,
    });

    const companyId = message.trace?.companyId ?? '';
    const conversationKey = `${message.channel}:${message.trace?.larkTenantKey ?? 'no_tenant'}:${message.chatId}`;

    const requestContext = new RequestContext<Record<string, unknown>>();
    requestContext.set('taskId', task.taskId);
    requestContext.set('messageId', message.messageId);
    requestContext.set('userId', message.userId);
    requestContext.set('chatId', message.chatId);
    requestContext.set('channel', message.channel);
    requestContext.set('companyId', companyId);
    requestContext.set('larkTenantKey', message.trace?.larkTenantKey ?? '');
    requestContext.set('requestId', message.trace?.requestId ?? '');
    requestContext.set('channelIdentityId', message.trace?.channelIdentityId ?? '');

    // ── Stage 1: Instant "Thinking" indicator ───────────────────────────────
    // Fire this synchronously before ANY async work so the user sees feedback
    // within ~200ms of receiving the webhook, regardless of DB/LLM latency.
    const channelAdapter = resolveChannelAdapter(message.channel);
    let progressMessageId: string | undefined;
    let progressCommittedText = '';
    let progressBufferedText = '';
    let lastPushedPreviewText = '';
    let lastPushAt = 0;

    const updateStageIndicator = async (text: string): Promise<void> => {
      try {
        if (!progressMessageId) {
          const outbound = await channelAdapter.sendMessage({
            chatId: message.chatId,
            text,
            correlationId: task.taskId,
          });
          progressMessageId = outbound.messageId;
          lastPushedPreviewText = text;
          lastPushAt = Date.now();
          logger.info('mastra.engine.stage.sent', { taskId: task.taskId, stage: text.slice(0, 40) });
        } else {
          await channelAdapter.updateMessage({
            messageId: progressMessageId,
            text,
            correlationId: task.taskId,
          });
          lastPushedPreviewText = text;
          lastPushAt = Date.now();
          logger.info('mastra.engine.stage.updated', { taskId: task.taskId, stage: text.slice(0, 40) });
        }
      } catch (error) {
        logger.warn('mastra.engine.stage.failed', {
          taskId: task.taskId,
          stage: text.slice(0, 40),
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    };

    // Fire and do NOT await — this must never block the pipeline.
    // If Lark is slow the indicator just appears a bit late but never hangs.
    void updateStageIndicator('_Processing your request..._');

    // ── DB Lookups & Context Building ────────────────────────────────────────
    const userRole = (message.trace?.userRole ?? 'MEMBER') as AiRole;
    const requesterUserId =
      typeof message.trace?.channelIdentityId === 'string' && message.trace.channelIdentityId.trim().length > 0
        ? message.trace.channelIdentityId.trim()
        : message.userId;
    const allowedToolIds = companyId
      ? await toolPermissionService.getAllowedTools(companyId, userRole)
      : [];
    requestContext.set('allowedToolIds', allowedToolIds);

    // ── Stage 2: Personalizing ───────────────────────────────────────────────
    void updateStageIndicator('_Retrieving your context..._');

    let personalContextMatches: Array<{ role?: string; content: string }> = [];
    if (companyId && requesterUserId) {
      try {
        personalContextMatches = await personalVectorMemoryService.query({
          companyId,
          requesterUserId,
          text: message.text,
          limit: PERSONAL_CONTEXT_LIMIT,
        });
      } catch (error) {
        logger.warn('personal.vector.query.failed', {
          taskId: task.taskId,
          companyId,
          requesterUserId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    }

    conversationMemoryStore.addUserMessage(conversationKey, message.messageId, message.text);
    const contextMessages = conversationMemoryStore.getContextMessages(
      conversationKey,
      HISTORY_CONTEXT_MESSAGE_LIMIT,
    );
    const historyAwarePrompt = buildHistoryAwarePrompt(contextMessages, personalContextMatches, message.text);

    const pendingPersistence: Array<Promise<void>> = [];
    if (companyId && requesterUserId) {
      pendingPersistence.push(
        personalVectorMemoryService.storeChatTurn({
          companyId,
          requesterUserId,
          conversationKey,
          sourceId: message.messageId,
          role: 'user',
          text: message.text,
          channel: message.channel,
          chatId: message.chatId,
        }).catch((error) => {
          logger.warn('personal.vector.store.user.failed', {
            taskId: task.taskId,
            companyId,
            requesterUserId,
            sourceId: message.messageId,
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
        }),
      );
    }

    // ── Stage 3: Working on it ───────────────────────────────────────────────
    void updateStageIndicator('_Generating response..._');

    // ── Agent stream ─────────────────────────────────────────────────────────
    const agent = mastra.getAgent('supervisorAgent');
    const runOptions = await buildMastraAgentRunOptions('mastra.supervisor', { requestContext });

    let streamResult;
    try {
      streamResult = await withTimeout(
        agent.stream([{ role: 'user', content: historyAwarePrompt }], runOptions as any),
        AGENT_GENERATE_TIMEOUT_MS,
        'supervisorAgent.stream',
      );
    } catch (err) {
      logger.error('mastra.engine.stream.failed', {
        taskId: task.taskId,
        messageId: message.messageId,
        companyId,
        reason: err instanceof Error ? err.message : 'unknown_error',
        timedOut: err instanceof Error && err.message.includes('timed out'),
      });
      throw err;
    }

    // ── Handle steps and text stream for natural progress updates ────────────

    // Collect the final text and handle streams
    let fullText = '';

    // We run the text stream and step stream concurrently
    const [stream, stepStream] = [streamResult.textStream, (streamResult as any).stepsStream];

    const pushProgress = async (force = false): Promise<void> => {
      const now = Date.now();
      // If ack was already sent we count that as a push, so the interval
      // is measured against when it was dispatched, not epoch 0.
      const intervalElapsed = now - lastPushAt >= PROGRESS_MIN_UPDATE_INTERVAL_MS;
      const split = splitProgressBuffer(progressBufferedText, {
        force,
        intervalElapsed,
      });

      if (!split) {
        return;
      }

      progressCommittedText += split.flushText;
      progressBufferedText = split.remainder;

      const preview = progressCommittedText.trim();
      if (!preview) {
        return;
      }

      const enoughForFirstMessage = preview.length >= PROGRESS_MIN_INITIAL_CHARS;
      const hasMeaningfulDelta =
        Math.abs(preview.length - lastPushedPreviewText.length) >= PROGRESS_MIN_UPDATE_DELTA_CHARS;

      if (!force) {
        // We already sent the ack so progressMessageId is always set by here.
        // Only push a streamed update if the content has changed meaningfully.
        if (progressMessageId && !hasMeaningfulDelta && !intervalElapsed) {
          return;
        }
        // If progressMessageId is somehow not set, only send once enough text.
        if (!progressMessageId && !enoughForFirstMessage) {
          return;
        }
      }

      if (!progressMessageId) {
        const outbound = await channelAdapter.sendMessage({
          chatId: message.chatId,
          text: preview,
          correlationId: task.taskId,
        });
        progressMessageId = outbound.messageId;
      } else {
        await channelAdapter.updateMessage({
          messageId: progressMessageId,
          text: preview,
          correlationId: task.taskId,
        });
      }
      lastPushedPreviewText = preview;
      lastPushAt = now;
    };

    const buildToolProgressFallback = (toolNames: string[]): string => {
      const objective = message.text.trim();
      if (toolNames.includes('zoho-agent')) {
        return `Understood. I’m checking Zoho CRM data for "${objective}" now. I’ll share the results shortly.`;
      }
      if (toolNames.includes('search-agent')) {
        return `Understood. I’m searching the web for "${objective}" and pulling page context from the most relevant site results now.`;
      }
      if (toolNames.includes('outreach-agent')) {
        return `Understood. I’m checking outreach publisher data for "${objective}" now. I’ll share results shortly.`;
      }
      if (toolNames.includes('lark-doc-agent') || toolNames.includes('create-lark-doc') || toolNames.includes('edit-lark-doc')) {
        return `Understood. I’m preparing a Lark Doc for "${objective}" now and will share the document details shortly.`;
      }
      return `Understood. I’m working on "${objective}" now and will update you as I make progress.`;
    };

    // Listen to steps to send progress updates to the user
    const stepListenerPromise = (async () => {
      try {
        if (stepStream) {
          for await (const step of stepStream) {
            const toolResults = (step as any).toolResults || {};
            const toolCalls = (step as any).toolCalls || [];

            if (Object.keys(toolResults).length > 0) {
              logger.info('mastra.engine.tool.results', {
                taskId: task.taskId,
                toolResults,
              });
            }

            if (toolCalls.length > 0) {
              const toolNames = toolCalls
                .map((tc: any) => (typeof tc?.toolName === 'string' ? tc.toolName : ''))
                .filter(Boolean);

              // Preferred path: push model-authored acknowledgement streamed from the agent.
              if ((progressCommittedText + progressBufferedText).trim().length >= PROGRESS_MIN_INITIAL_CHARS) {
                await pushProgress(true);
                continue;
              }

              // Safety fallback when a tool starts before the model streams text.
              const fallback = buildToolProgressFallback(toolNames);
              if (!progressMessageId) {
                const outbound = await channelAdapter.sendMessage({
                  chatId: message.chatId,
                  text: fallback,
                  correlationId: task.taskId,
                });
                progressMessageId = outbound.messageId;
              } else {
                await channelAdapter.updateMessage({
                  messageId: progressMessageId,
                  text: fallback,
                  correlationId: task.taskId,
                });
              }
              lastPushedPreviewText = fallback;
              lastPushAt = Date.now();
            }
          }
        }
      } catch (e) {
        logger.error('mastra.engine.progress.failed', { taskId: task.taskId, error: e });
      }
    })();

    try {
      for await (const delta of stream) {
        fullText += delta;
        progressBufferedText += delta;
        await pushProgress(false);
      }
    } catch (error) {
      await pushProgress(true);
      throw error;
    }
    await pushProgress(true);
    await stepListenerPromise;

    await checkpointRepository.save(task.taskId, 'synthesis.complete', {
      status: 'done',
      text: fullText,
      provider: 'mastra-sdk',
      channel: message.channel,
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: message.chatType,
      timestamp: message.timestamp,
      userId: message.userId,
      requestId: message.trace?.requestId,
      eventId: message.trace?.eventId,
      textHash: message.trace?.textHash,
    });

    const rawFinalText = fullText.trim().length > 0 ? fullText : 'Done.';
    const limitedOutput = applyGenerationWordLimit(rawFinalText, config.DOC_GENERATION_MAX_WORDS);
    const finalText = limitedOutput.text;
    conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, finalText);

    if (companyId && requesterUserId) {
      pendingPersistence.push(
        personalVectorMemoryService.storeChatTurn({
          companyId,
          requesterUserId,
          conversationKey,
          sourceId: task.taskId,
          role: 'assistant',
          text: finalText,
          channel: message.channel,
          chatId: message.chatId,
        }).catch((error) => {
          logger.warn('personal.vector.store.assistant.failed', {
            taskId: task.taskId,
            companyId,
            requesterUserId,
            sourceId: task.taskId,
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
        }),
      );
    }

    const canShareVectors = allowedToolIds.includes('share_chat_vectors');
    const shareActions = canShareVectors
      ? [
        {
          id: 'share_vectors',
          label: 'Share this chat\'s knowledge',
          value: { conversationKey, triggerMessageId: progressMessageId ?? '' },
          style: 'default' as const,
        },
      ]
      : undefined;

    if (progressMessageId) {
      await channelAdapter.updateMessage({
        messageId: progressMessageId,
        text: finalText,
        correlationId: task.taskId,
        actions: shareActions,
      });
    } else {
      await channelAdapter.sendMessage({
        chatId: message.chatId,
        text: finalText,
        correlationId: task.taskId,
        actions: shareActions,
      });
    }

    if (pendingPersistence.length > 0) {
      await Promise.allSettled(pendingPersistence);
    }

    if (limitedOutput.truncated) {
      logger.warn('mastra.engine.output.truncated', {
        taskId: task.taskId,
        messageId: message.messageId,
        companyId,
        reasonCode: limitedOutput.reasonCode,
        maxWords: config.DOC_GENERATION_MAX_WORDS,
      });
    }

    logger.info('mastra.engine.request.success', {
      taskId: task.taskId,
      messageId: message.messageId,
      requestId: message.trace?.requestId,
      companyId: message.trace?.companyId,
    });

    return {
      task,
      status: 'done',
      currentStep: 'synthesis.compose',
      latestSynthesis: finalText,
      runtimeMeta: {
        engine: 'mastra',
        node: 'synthesis.complete',
        stepHistory: ['mastra.request', 'synthesis.complete'],
      },
    };
  }
}

export const mastraOrchestrationEngine = new MastraOrchestrationEngine();
