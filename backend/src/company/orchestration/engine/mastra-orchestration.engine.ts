import { RequestContext } from '@mastra/core/di';

import { resolveChannelAdapter } from '../../channels';
import { mastra } from '../../integrations/mastra';
import { logger } from '../../../utils/logger';
import { checkpointRepository } from '../../state/checkpoint';
import { orchestratorService } from '../orchestrator.service';
import { toolPermissionService } from '../../tools/tool-permission.service';
import type { AiRole } from '../../tools/tool-registry';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';

// Maximum time (ms) we wait for the LLM agent to respond before aborting.
// Keep this shorter than any upstream HTTP gateway timeout.
const AGENT_GENERATE_TIMEOUT_MS = 50_000;

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

    // ── Agent generate with hard timeout ────────────────────────────────────
    // Without this the call hangs until the upstream HTTP gateway kills it
    // (at ~12 s in the logs), which then triggers a retry, which spawns
    // another agent run — forming the loop.
    const agent = mastra.getAgent('supervisorAgent');
    const channelAdapter = resolveChannelAdapter(message.channel);

    let streamResult;
    try {
      streamResult = await withTimeout(
        agent.stream([{ role: 'user', content: message.text }], { requestContext }),
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

    // ── Handle steps and tool calls for progress updates ─────────────────────
    let progressMessageId: string | undefined;

    // Collect the final text and handle streams
    let fullText = '';

    // We run the text stream and step stream concurrently
    const [stream, stepStream] = [streamResult.textStream, (streamResult as any).stepsStream];

    // Listen to steps to send progress updates to the user
    (async () => {
      try {
        if (stepStream) {
          for await (const step of stepStream) {
            const toolCalls = (step as any).toolCalls || [];
            if (toolCalls.length > 0) {
              const toolNames = toolCalls.map((tc: any) => tc.toolName).join(', ');
              const text = `🔍 Working on it... (Using: ${toolNames})`;

              if (!progressMessageId) {
                const res = await channelAdapter.sendMessage({
                  chatId: message.chatId,
                  text,
                  correlationId: task.taskId,
                });
                progressMessageId = res.messageId;
              } else {
                await channelAdapter.updateMessage({
                  messageId: progressMessageId,
                  text,
                  correlationId: task.taskId,
                });
              }
            }
          }
        }
      } catch (e) {
        logger.error('mastra.engine.progress.failed', { taskId: task.taskId, error: e });
      }
    })();

    for await (const delta of stream) {
      fullText += delta;
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

    if (progressMessageId) {
      await channelAdapter.updateMessage({
        messageId: progressMessageId,
        text: fullText,
        correlationId: task.taskId,
      });
    } else {
      await channelAdapter.sendMessage({
        chatId: message.chatId,
        text: fullText,
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
      latestSynthesis: fullText,
      runtimeMeta: {
        engine: 'mastra',
        node: 'synthesis.complete',
        stepHistory: ['mastra.request', 'synthesis.complete'],
      },
    };
  }
}

export const mastraOrchestrationEngine = new MastraOrchestrationEngine();
