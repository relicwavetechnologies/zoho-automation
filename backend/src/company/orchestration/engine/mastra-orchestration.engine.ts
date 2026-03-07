import { RequestContext } from '@mastra/core/di';

import { resolveChannelAdapter } from '../../channels';
import { mastra } from '../../integrations/mastra';
import { buildMastraAgentRunOptions } from '../../integrations/mastra/mastra-model-control';
import { logger } from '../../../utils/logger';
import { checkpointRepository } from '../../state/checkpoint';
import { conversationMemoryStore } from '../../state/conversation';
import { orchestratorService } from '../orchestrator.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import type { AiRole } from '../../tools/tool-registry';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';

// Maximum time (ms) we wait for the LLM agent to respond before aborting.
// Keep this shorter than any upstream HTTP gateway timeout.
const AGENT_GENERATE_TIMEOUT_MS = 50_000;
const PROGRESS_MIN_INITIAL_CHARS = 20;
const PROGRESS_MIN_UPDATE_DELTA_CHARS = 24;
const PROGRESS_MIN_UPDATE_INTERVAL_MS = 900;
const PROGRESS_MAX_BUFFER_CHARS = 160;
const HISTORY_CONTEXT_MESSAGE_LIMIT = 14;
const HISTORY_PREFIX_LIMIT = 12;

const buildHistoryAwarePrompt = (
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  currentMessageText: string,
): string => {
  const normalizedCurrent = currentMessageText.trim();
  const contextOnly = history.filter(
    (entry, index) =>
      !(index === history.length - 1 && entry.role === 'user' && entry.content.trim() === normalizedCurrent),
  );

  if (contextOnly.length === 0) {
    return currentMessageText;
  }

  const transcript = contextOnly
    .slice(-HISTORY_PREFIX_LIMIT)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
    .join('\n');

  return [
    'Conversation context from this same chat (most recent first-order history):',
    transcript,
    '',
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
    requestContext.set('allowedToolIds', allowedToolIds);

    conversationMemoryStore.addUserMessage(conversationKey, message.messageId, message.text);
    const contextMessages = conversationMemoryStore.getContextMessages(
      conversationKey,
      HISTORY_CONTEXT_MESSAGE_LIMIT,
    );
    const historyAwarePrompt = buildHistoryAwarePrompt(contextMessages, message.text);

    // ── Agent generate with hard timeout ────────────────────────────────────
    // Without this the call hangs until the upstream HTTP gateway kills it
    // (at ~12 s in the logs), which then triggers a retry, which spawns
    // another agent run — forming the loop.
    const agent = mastra.getAgent('supervisorAgent');
    const channelAdapter = resolveChannelAdapter(message.channel);

    let streamResult;
    try {
      const runOptions = await buildMastraAgentRunOptions('mastra.supervisor', { requestContext });
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
    let progressMessageId: string | undefined;
    let progressCommittedText = '';
    let progressBufferedText = '';
    let lastPushedPreviewText = '';
    let lastPushAt = 0;

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

    const finalText = fullText.trim().length > 0 ? fullText : 'Done.';
    conversationMemoryStore.addAssistantMessage(conversationKey, task.taskId, finalText);

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
