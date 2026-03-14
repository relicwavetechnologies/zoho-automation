import { RequestContext } from '@mastra/core/di';

import config from '../../../config';
import { resolveChannelAdapter } from '../../channels';
import { channelIdentityRepository } from '../../channels/channel-identity.repository';
import { mastra } from '../../integrations/mastra';
import { buildMastraAgentRunOptions } from '../../integrations/mastra/mastra-model-control';
import { personalVectorMemoryService } from '../../integrations/vector';
import { logger } from '../../../utils/logger';
import { classifyRuntimeError } from '../../observability';
import { checkpointRepository } from '../../state/checkpoint';
import { conversationMemoryStore } from '../../state/conversation';
import { applyGenerationWordLimit } from '../../support/content-limits';
import { orchestratorService } from '../orchestrator.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import { knowledgeShareService } from '../../knowledge-share/knowledge-share.service';
import { registerActivityBus, unregisterActivityBus, type ActivityPayload } from '../../integrations/mastra/tools/activity-bus';
import { prisma } from '../../../utils/prisma';
import type { AiRole } from '../../tools/tool-registry';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';
import { buildVisionContent, type AttachedFileRef } from '../../../modules/desktop-chat/file-vision.builder';
import { larkRecentFilesStore } from '../../channels/lark/lark-recent-files.store';
import { orangeDebug } from '../../../utils/orange-debug';

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

/**
 * Resolves the canonical userId to use as the `ownerUserId` for personal vector memory.
 *
 * Priority chain (highest → lowest):
 * 1. `trace.linkedUserId`      — the sender has linked their Lark account to an internal
 *                                Desktop User, so we share one memory bucket for both channels.
 * 2. `trace.channelIdentityId` — the sender is known but not linked; use the channel-scoped id.
 * 3. `message.userId`          — raw fallback (e.g. Lark open_id) when no identity is resolved.
 */
const resolveRequesterUserId = (trace: {
  linkedUserId?: string;
  channelIdentityId?: string;
} | undefined, fallbackUserId: string): string => {
  const linked = trace?.linkedUserId?.trim();
  if (linked) return linked;
  const channelId = trace?.channelIdentityId?.trim();
  if (channelId) return channelId;
  return fallbackUserId;
};

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

const ensureOutboundSucceeded = (
  outbound:
    | Awaited<ReturnType<ReturnType<typeof resolveChannelAdapter>['sendMessage']>>
    | Awaited<ReturnType<ReturnType<typeof resolveChannelAdapter>['updateMessage']>>,
  context: {
    phase: string;
    taskId: string;
    messageId: string;
    chatId: string;
  },
) => {
  if (outbound.status !== 'failed') {
    return outbound;
  }

  logger.warn('mastra.engine.egress.failed', {
    phase: context.phase,
    taskId: context.taskId,
    messageId: context.messageId,
    chatId: context.chatId,
    error: outbound.error,
  });
  throw new Error(outbound.error?.rawMessage ?? outbound.error?.classifiedReason ?? `${context.phase} failed`);
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

export const createSerializedStageUpdater = (
  update: (text: string) => Promise<void>,
): ((text: string) => Promise<void>) => {
  let chain = Promise.resolve();

  return (text: string) => {
    chain = chain.then(() => update(text));
    return chain;
  };
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
          const requesterAiRole = message.trace?.userRole ?? 'MEMBER';

          if (companyId && conversationKey && requesterUserId) {
            const shareResult = await knowledgeShareService.requestConversationShare({
              companyId,
              requesterUserId,
              requesterChannelIdentityId: message.trace?.channelIdentityId,
              requesterAiRole,
              conversationKey,
            });

            const requesterText =
              shareResult.status === 'auto_shared'
                ? '_Knowledge shared company-wide._'
                : shareResult.status === 'shared_notified'
                  ? '_Knowledge shared company-wide and admins were notified._'
                  : shareResult.status === 'delivery_failed'
                    ? '_Share request created, but admin delivery failed. Check the admin dashboard logs._'
                    : '_Share request submitted — pending administrator review._';
            if (triggerMessageId) {
              await channelAdapter.updateMessage({
                messageId: triggerMessageId,
                text: requesterText,
                correlationId: task.taskId,
                actions: [], // Remove the button; no double-clicks.
              });
            }

            logger.info('mastra.engine.share_vectors.request.dispatched', {
              taskId: task.taskId,
              companyId,
              conversationKey,
              requestId: shareResult.id,
              status: shareResult.status,
              classification: shareResult.classification,
            });
          }
        }

        // ── Admin taps Approve or Reject ─────────────────────────────────────
        if (actionId === 'admin_share_decision') {
          const requestId = typeof action.requestId === 'string' ? action.requestId : undefined;
          const decision = action.decision === 'approve' || action.decision === 'reject' ? action.decision : undefined;
          const adminMessageId = message.messageId;

          if (requestId && decision) {
            const shareRow = await prisma.vectorShareRequest.findUnique({ where: { id: requestId } });

            if (shareRow && (shareRow.status === 'pending' || shareRow.status === 'delivery_failed')) {
              if (decision === 'approve') {
                const approved = await knowledgeShareService.approveRequest({
                  requestId,
                  reviewerUserId: message.userId,
                });
                if (adminMessageId) {
                  const confirmText = [
                    '_Approved — knowledge is now shared company-wide._',
                    approved.summary ? `\n_Summary: ${approved.summary}_` : '',
                  ].join('');
                  await channelAdapter.updateMessage({
                    messageId: adminMessageId,
                    text: confirmText,
                    correlationId: task.taskId,
                    actions: [
                      {
                        id: 'admin_share_revert',
                        label: 'Revert',
                        value: { requestId },
                        style: 'danger',
                      },
                    ],
                  });
                }
              } else {
                await knowledgeShareService.rejectRequest({
                  requestId,
                  reviewerUserId: message.userId,
                });
                if (adminMessageId) {
                  await channelAdapter.updateMessage({
                    messageId: adminMessageId,
                    text: '_Rejected — personal vectors remain private._',
                    correlationId: task.taskId,
                    actions: [],
                  });
                }
              }

              logger.info('mastra.engine.admin_share_decision.completed', {
                taskId: task.taskId,
                requestId,
                decision,
              });
            } else if (adminMessageId) {
              await channelAdapter.updateMessage({
                messageId: adminMessageId,
                text: '_This share request was already handled by another admin._',
                correlationId: task.taskId,
                actions: [],
              });
            }
          }
        }

        if (actionId === 'admin_share_revert') {
          const requestId = typeof action.requestId === 'string' ? action.requestId : undefined;
          const adminMessageId = message.messageId;

          if (requestId) {
            const reverted = await knowledgeShareService.revertRequest({
              requestId,
              reviewerUserId: message.userId,
            });

            if (adminMessageId) {
              const confirmText = reverted.status === 'reverted'
                ? [
                  '_Reverted — previously shared knowledge is private again._',
                  reverted.summary ? `\n_Summary: ${reverted.summary}_` : '',
                ].join('')
                : '_This share request could not be reverted in its current state._';
              await channelAdapter.updateMessage({
                messageId: adminMessageId,
                text: confirmText,
                correlationId: task.taskId,
                actions: [],
              });
            }

            logger.info('mastra.engine.admin_share_revert.completed', {
              taskId: task.taskId,
              requestId,
              status: reverted.status,
            });
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
    requestContext.set('requesterEmail', message.trace?.requesterEmail ?? '');
    requestContext.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

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
          const outbound = ensureOutboundSucceeded(await channelAdapter.sendMessage({
            chatId: message.chatId,
            text,
            correlationId: task.taskId,
          }), {
            phase: 'stage.send',
            taskId: task.taskId,
            messageId: message.messageId,
            chatId: message.chatId,
          });
          progressMessageId = outbound.messageId;
          lastPushedPreviewText = text;
          lastPushAt = Date.now();
          logger.info('mastra.engine.stage.sent', { taskId: task.taskId, stage: text.slice(0, 40) });
          orangeDebug('mastra.stage.send', {
            taskId: task.taskId,
            inboundMessageId: message.messageId,
            chatId: message.chatId,
            progressMessageId,
            stage: text,
          });
        } else {
          ensureOutboundSucceeded(await channelAdapter.updateMessage({
            messageId: progressMessageId,
            text,
            correlationId: task.taskId,
          }), {
            phase: 'stage.update',
            taskId: task.taskId,
            messageId: message.messageId,
            chatId: message.chatId,
          });
          lastPushedPreviewText = text;
          lastPushAt = Date.now();
          logger.info('mastra.engine.stage.updated', { taskId: task.taskId, stage: text.slice(0, 40) });
          orangeDebug('mastra.stage.update', {
            taskId: task.taskId,
            inboundMessageId: message.messageId,
            chatId: message.chatId,
            progressMessageId,
            stage: text,
          });
        }
      } catch (error) {
        logger.warn('mastra.engine.stage.failed', {
          taskId: task.taskId,
          stage: text.slice(0, 40),
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
        orangeDebug('mastra.stage.failed', {
          taskId: task.taskId,
          inboundMessageId: message.messageId,
          chatId: message.chatId,
          stage: text,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    };
    const queueStageIndicator = createSerializedStageUpdater(updateStageIndicator);

    // Fire and do NOT await — this must never block the pipeline.
    // If Lark is slow the indicator just appears a bit late but never hangs.
    void queueStageIndicator('_Processing your request..._');

    // ── DB Lookups & Context Building ────────────────────────────────────────
    const userRole = (message.trace?.userRole ?? 'MEMBER') as AiRole;
    requestContext.set('requesterAiRole', userRole);
    const requesterUserId = resolveRequesterUserId(message.trace, message.userId);
    const allowedToolIds = companyId
      ? await toolPermissionService.getAllowedTools(companyId, userRole)
      : [];
    requestContext.set('allowedToolIds', allowedToolIds);

    // ── Stage 2: Personalizing ───────────────────────────────────────────────
    void queueStageIndicator('_Retrieving your context..._');

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
    void queueStageIndicator('_Generating response..._');

    // ── Agent stream ─────────────────────────────────────────────────────────
    const agent = mastra.getAgent('supervisorAgent');
    const runOptions = await buildMastraAgentRunOptions('mastra.supervisor', { requestContext });

    // ── Attachment vision injection ───────────────────────────────────────────
    // Merge explicit attachedFiles (sent in same message) with recent files
    // from the per-chat TTL store (sent in a previous Lark message).
    // This allows follow-up questions like "what is this image?" to work
    // even when the image was sent as a standalone message earlier.
    const recentFiles = message.channel === 'lark'
      ? larkRecentFilesStore.consume(message.chatId)
      : [];
    const allAttachedFiles = [
      ...(message.attachedFiles ?? []),
      // Only include recent files not already in the current message
      ...recentFiles.filter(
        (rf) => !(message.attachedFiles ?? []).some((af) => af.fileAssetId === rf.fileAssetId),
      ),
    ];

    if (recentFiles.length > 0) {
      logger.info('mastra.engine.recent_files.merged', {
        taskId: task.taskId,
        messageId: message.messageId,
        chatId: message.chatId,
        recentFileCount: recentFiles.length,
        totalFiles: allAttachedFiles.length,
      });
    }
    orangeDebug('mastra.attachments.resolved', {
      taskId: task.taskId,
      inboundMessageId: message.messageId,
      chatId: message.chatId,
      explicitAttachedFileCount: message.attachedFiles?.length ?? 0,
      recentFileCount: recentFiles.length,
      totalAttachedFileCount: allAttachedFiles.length,
      fileAssetIds: allAttachedFiles.map((file) => file.fileAssetId),
    });

    // If the incoming message (from Lark or any channel) has attached files,
    // convert them to Vercel AI SDK vision/document parts exactly like Desktop.
    let agentInputMessages: Array<{ role: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> }> = [
      { role: 'user', content: historyAwarePrompt },
    ];

    if (allAttachedFiles.length > 0) {
      try {
        const visionParts = await buildVisionContent({
          userMessage: historyAwarePrompt,
          attachedFiles: allAttachedFiles as AttachedFileRef[],
          companyId,
          requesterUserId,
          requesterAiRole: userRole,
        });
        const hasImageParts = visionParts.some((p) => p.type === 'image');
        if (hasImageParts) {
          // Multipart vision message for image-capable models
          agentInputMessages = [{ role: 'user', content: visionParts as Array<{ type: string; [k: string]: unknown }> }];
        } else {
          // Text-only doc chunks — collapse to extended prompt string
          const docText = visionParts.filter((p) => p.type === 'text').map((p) => (p as any).text as string).join('\n');
          agentInputMessages = [{ role: 'user', content: docText }];
        }
        logger.info('mastra.engine.vision.injected', {
          taskId: task.taskId,
          messageId: message.messageId,
          fileCount: allAttachedFiles.length,
          hasImageParts,
        });
        orangeDebug('mastra.vision.injected', {
          taskId: task.taskId,
          inboundMessageId: message.messageId,
          chatId: message.chatId,
          fileCount: allAttachedFiles.length,
          hasImageParts,
          partTypes: visionParts.map((part) => part.type),
        });
      } catch (visionErr) {
        logger.warn('mastra.engine.vision.injection_failed', {
          taskId: task.taskId,
          messageId: message.messageId,
          error: visionErr instanceof Error ? visionErr.message : 'unknown_error',
        });
        orangeDebug('mastra.vision.failed', {
          taskId: task.taskId,
          inboundMessageId: message.messageId,
          chatId: message.chatId,
          error: visionErr instanceof Error ? visionErr.message : 'unknown_error',
        });
        // Fall through — use plain text prompt as fallback
      }
    }

    let fullText = '';
    let usedCompanyWorkflow = false;

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
        const outbound = ensureOutboundSucceeded(await channelAdapter.sendMessage({
          chatId: message.chatId,
          text: preview,
          correlationId: task.taskId,
        }), {
          phase: 'progress.send',
          taskId: task.taskId,
          messageId: message.messageId,
          chatId: message.chatId,
        });
        progressMessageId = outbound.messageId;
        orangeDebug('mastra.progress.send', {
          taskId: task.taskId,
          inboundMessageId: message.messageId,
          chatId: message.chatId,
          progressMessageId,
          previewLength: preview.length,
        });
      } else {
        ensureOutboundSucceeded(await channelAdapter.updateMessage({
          messageId: progressMessageId,
          text: preview,
          correlationId: task.taskId,
        }), {
          phase: 'progress.update',
          taskId: task.taskId,
          messageId: message.messageId,
          chatId: message.chatId,
        });
        orangeDebug('mastra.progress.update', {
          taskId: task.taskId,
          inboundMessageId: message.messageId,
          chatId: message.chatId,
          progressMessageId,
          previewLength: preview.length,
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

    const buildTemporalContext = (): string => {
      const now = new Date();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const exactDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone,
      }).format(now);
      const exactTime = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }).format(now);

      return [
        '--- CURRENT DATE CONTEXT ---',
        `Today is ${exactDate}. Current local time is ${exactTime}.`,
        `Use timezone ${timeZone} for relative scheduling requests.`,
        'Resolve relative dates like "today", "tomorrow", "next Monday", and "next week" against this date.',
        'When scheduling or confirming dates, include the exact calendar date in the final answer.',
        '--- END CURRENT DATE CONTEXT ---',
      ].join('\n');
    };

    const workflowRequestId = (message.trace?.requestId ?? '').trim();
    const workflowActivityListener = (type: 'activity' | 'activity_done', payload: ActivityPayload) => {
      if (type !== 'activity') {
        return;
      }
      void updateStageIndicator(buildToolProgressFallback([payload.name]));
    };

    if (workflowRequestId) {
      registerActivityBus(workflowRequestId, workflowActivityListener);
    }
    try {
      const workflow = mastra.getWorkflow('companyWorkflow');
      const run = await workflow.createRun({ runId: workflowRequestId || task.taskId });
      const workflowStream = run.stream({
          inputData: {
            userObjective: [buildTemporalContext(), historyAwarePrompt].join('\n\n'),
            requestContext: {
              userId: message.userId,
              permissions: allowedToolIds,
            },
            attachmentContent: allAttachedFiles.length > 0 ? historyAwarePrompt : undefined,
            agentId: 'supervisorAgent',
            mode: 'high',
            agentMessages: agentInputMessages,
          } as any,
          requestContext: requestContext as unknown as RequestContext<unknown>,
          initialState: {
            currentPlan: null,
            failedTasks: [],
            completedTasks: [],
            replanCount: 0,
          },
        } as any);

      for await (const rawEvent of workflowStream.fullStream) {
        const event = (rawEvent as any)?.type === 'watch'
          ? (rawEvent as any).data
          : rawEvent;
        if (event?.type === 'workflow-step-result' && event?.payload?.id === 'planner-step' && event.payload.status === 'success') {
          void updateStageIndicator('_Plan ready. Working through it..._');
        }
      }

      const workflowResult = await workflowStream.result;
      if (workflowResult?.status !== 'success') {
        const workflowError =
          workflowResult?.status === 'failed' && workflowResult.error instanceof Error
            ? workflowResult.error.message
            : `Workflow finished with status ${workflowResult?.status ?? 'unknown'}`;
        throw new Error(
          workflowError,
        );
      }

      fullText = typeof workflowResult.result?.finalAnswer === 'string'
        ? workflowResult.result.finalAnswer.trim()
        : '';
      usedCompanyWorkflow = true;
    } catch (error) {
      logger.warn('mastra.engine.workflow.fallback', {
        taskId: task.taskId,
        messageId: message.messageId,
        companyId,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    } finally {
      if (workflowRequestId) {
        unregisterActivityBus(workflowRequestId, workflowActivityListener);
      }
    }

    if (!usedCompanyWorkflow) {
      let streamResult;
      try {
        streamResult = await withTimeout(
          agent.stream(agentInputMessages as any, runOptions as any),
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

      const [stream, stepStream] = [streamResult.textStream, (streamResult as any).stepsStream];

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
                const outbound = ensureOutboundSucceeded(await channelAdapter.sendMessage({
                  chatId: message.chatId,
                  text: fallback,
                  correlationId: task.taskId,
                }), {
                  phase: 'tool-progress.send',
                  taskId: task.taskId,
                  messageId: message.messageId,
                  chatId: message.chatId,
                });
                progressMessageId = outbound.messageId;
              } else {
                ensureOutboundSucceeded(await channelAdapter.updateMessage({
                  messageId: progressMessageId,
                  text: fallback,
                  correlationId: task.taskId,
                }), {
                  phase: 'tool-progress.update',
                  taskId: task.taskId,
                  messageId: message.messageId,
                  chatId: message.chatId,
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
    }

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

    try {
      let deliveredMessageId = progressMessageId;
      if (progressMessageId) {
        ensureOutboundSucceeded(await channelAdapter.updateMessage({
          messageId: progressMessageId,
          text: finalText,
          correlationId: task.taskId,
          actions: shareActions,
        }), {
          phase: 'final.update',
          taskId: task.taskId,
          messageId: message.messageId,
          chatId: message.chatId,
        });
      } else {
        const outbound = ensureOutboundSucceeded(await channelAdapter.sendMessage({
          chatId: message.chatId,
          text: finalText,
          correlationId: task.taskId,
          actions: shareActions,
        }), {
          phase: 'final.send',
          taskId: task.taskId,
          messageId: message.messageId,
          chatId: message.chatId,
        });
        deliveredMessageId = outbound.messageId;
      }

      logger.info('mastra.engine.response.send.success', {
        taskId: task.taskId,
        messageId: message.messageId,
        chatId: message.chatId,
        responseMessageId: deliveredMessageId,
      });
      orangeDebug('mastra.response.delivered', {
        taskId: task.taskId,
        inboundMessageId: message.messageId,
        chatId: message.chatId,
        deliveredMessageId,
        reusedProgressMessage: !!progressMessageId,
        finalTextLength: finalText.length,
      });

      await checkpointRepository.save(task.taskId, 'response.send', {
        status: 'done',
        sent: true,
        responseDeliveryStatus: 'sent',
        responseMessageId: deliveredMessageId,
        text: finalText,
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
    } catch (error) {
      const deliveryError = classifyRuntimeError(error);
      logger.error('mastra.engine.response.send.failed', {
        taskId: task.taskId,
        messageId: message.messageId,
        chatId: message.chatId,
        error: deliveryError,
      });
      await checkpointRepository.save(task.taskId, 'response.send', {
        status: 'failed',
        sent: false,
        responseDeliveryStatus: 'failed',
        responseDeliveryReason: deliveryError.classifiedReason,
        text: finalText,
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
      throw error;
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
