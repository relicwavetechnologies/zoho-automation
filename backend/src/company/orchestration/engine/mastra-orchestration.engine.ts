import { RequestContext } from '@mastra/core/di';

import config from '../../../config';
import { resolveChannelAdapter } from '../../channels';
import { mastra } from '../../integrations/mastra';
import { buildMastraAgentRunOptions } from '../../integrations/mastra/mastra-model-control';
import { personalVectorMemoryService } from '../../integrations/vector';
import { logger } from '../../../utils/logger';
import { checkpointRepository } from '../../state/checkpoint';
import { conversationMemoryStore } from '../../state/conversation';
import { applyGenerationWordLimit } from '../../support/content-limits';
import { orchestratorService } from '../orchestrator.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import type { AiRole } from '../../tools/tool-registry';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';

// Maximum time (ms) we wait for the LLM agent to respond before aborting.
// Keep this shorter than any upstream HTTP gateway timeout.
const AGENT_GENERATE_TIMEOUT_MS = 50_000;
const ACK_GENERATE_TIMEOUT_MS = 1_200;
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
    const userRole = (message.trace?.userRole ?? 'MEMBER') as AiRole;
    const requesterUserId =
      typeof message.trace?.channelIdentityId === 'string' && message.trace.channelIdentityId.trim().length > 0
        ? message.trace.channelIdentityId.trim()
        : message.userId;
    const allowedToolIds = companyId
      ? await toolPermissionService.getAllowedTools(companyId, userRole)
      : [];

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
    requestContext.set('allowedToolIds', allowedToolIds);

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

    // ── Agent generate with hard timeout ────────────────────────────────────
    // Without this the call hangs until the upstream HTTP gateway kills it
    // (at ~12 s in the logs), which then triggers a retry, which spawns
    // another agent run — forming the loop.
    const agent = mastra.getAgent('supervisorAgent');
    const ackAgent = mastra.getAgent('ackAgent');
    const channelAdapter = resolveChannelAdapter(message.channel);

    const ackPrompt = [
      'Write one short acknowledgement for the user request below.',
      'Do not answer it.',
      'Do not claim that you already checked the data.',
      'Keep it under 18 words.',
      `User request: ${message.text.trim()}`,
    ].join('\n');

    const ackRunOptionsPromise = buildMastraAgentRunOptions('mastra.ack', { requestContext });
    const ackPromise = (async () => {
      try {
        const runOptions = await ackRunOptionsPromise;
        const result = await withTimeout(
          ackAgent.generate(ackPrompt, runOptions as any),
          ACK_GENERATE_TIMEOUT_MS,
          'ackAgent.generate',
        );
        return normalizeAckText(result.text ?? '');
      } catch (error) {
        logger.debug('mastra.engine.ack.skipped', {
          taskId: task.taskId,
          messageId: message.messageId,
          companyId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
        return '';
      }
    })();

    let progressMessageId: string | undefined;
    let progressCommittedText = '';
    let progressBufferedText = '';
    let lastPushedPreviewText = '';
    let lastPushAt = 0;
    let responseSettled = false;

    const ackDispatchPromise = (async () => {
      const ackText = await ackPromise;
      if (!ackText || progressMessageId || responseSettled) {
        return;
      }

      const outbound = await channelAdapter.sendMessage({
        chatId: message.chatId,
        text: ackText,
        correlationId: task.taskId,
      });
      progressMessageId = outbound.messageId;
      lastPushedPreviewText = ackText;
      lastPushAt = Date.now();
      logger.info('mastra.engine.ack.sent', {
        taskId: task.taskId,
        messageId: message.messageId,
        companyId,
      });
    })().catch((error) => {
      logger.warn('mastra.engine.ack.failed', {
        taskId: task.taskId,
        messageId: message.messageId,
        companyId,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    });

    let streamResult;
    try {
      const runOptions = await buildMastraAgentRunOptions('mastra.supervisor', { requestContext });
      streamResult = await withTimeout(
        agent.stream([{ role: 'user', content: historyAwarePrompt }], runOptions as any),
        AGENT_GENERATE_TIMEOUT_MS,
        'supervisorAgent.stream',
      );
    } catch (err) {
      responseSettled = true;
      await ackDispatchPromise;
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
        if (!progressMessageId && !enoughForFirstMessage) {
          return;
        }
        if (progressMessageId && !hasMeaningfulDelta && !intervalElapsed) {
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
      responseSettled = true;
      await ackDispatchPromise;
      throw error;
    }
    await pushProgress(true);
    await stepListenerPromise;
    responseSettled = true;
    await ackDispatchPromise;

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

    if (progressMessageId) {
      await channelAdapter.updateMessage({
        messageId: progressMessageId,
        text: finalText,
        correlationId: task.taskId,
      });
    } else {
      await channelAdapter.sendMessage({
        chatId: message.chatId,
        text: finalText,
        correlationId: task.taskId,
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
