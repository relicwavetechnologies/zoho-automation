import { logger } from '../../../utils/logger';
import { resolveChannelAdapter } from '../../channels';
import type { ChannelAdapter } from '../../channels/base/channel-adapter';
import { classifyRuntimeError } from '../../observability';
import { orchestratorService } from '../orchestrator.service';
import { checkpointRepository } from '../../state/checkpoint';
import { hitlActionService } from '../../state/hitl';
import { runtimeControlSignalsRepository } from '../../queue/runtime/control-signals.repository';
import type { OrchestrationEngine, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';

const resolvePlanStartIndex = (plan: string[], latestNode?: string): number => {
  if (!latestNode) {
    return 0;
  }
  const index = plan.findIndex((step) => step === latestNode);
  if (index === -1) {
    return 0;
  }
  return Math.min(plan.length, index + 1);
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const buildStatusText = (input: {
  taskId: string;
  messageId: string;
  executionMode?: 'sequential' | 'parallel' | 'mixed';
  plan: string[];
  phase: 'processing' | 'awaiting_confirmation' | 'resuming' | 'processed' | 'failed' | 'cancelled';
  detail?: string;
}) => {
  const lines: string[] = [];
  const mode = input.executionMode ?? 'sequential';

  if (input.phase === 'processing') {
    lines.push(`Processing request (${input.taskId.slice(0, 8)})...`);
  } else if (input.phase === 'processed') {
    lines.push(`Processed (${mode}) for message ${input.messageId}.`);
  } else if (input.phase === 'awaiting_confirmation') {
    lines.push(`Awaiting confirmation (${input.taskId.slice(0, 8)})...`);
  } else if (input.phase === 'resuming') {
    lines.push(`Resuming request (${input.taskId.slice(0, 8)})...`);
  } else if (input.phase === 'cancelled') {
    lines.push(`Cancelled (${mode}) for message ${input.messageId}.`);
  } else {
    lines.push(`Failed (${mode}) for message ${input.messageId}.`);
  }

  lines.push(`Plan: ${input.plan.join(' -> ')}`);
  if (input.detail) {
    lines.push(input.detail);
  }

  return lines.join('\n');
};

const upsertLarkStatusMessage = async (input: {
  adapter: ChannelAdapter;
  chatId: string;
  correlationId: string;
  text: string;
  statusMessageId?: string;
}): Promise<string | undefined> => {
  if (input.statusMessageId) {
    const outbound = await input.adapter.updateMessage({
      messageId: input.statusMessageId,
      text: input.text,
      correlationId: input.correlationId,
    });

    return outbound.status === 'failed' ? input.statusMessageId : outbound.messageId ?? input.statusMessageId;
  }

  const outbound = await input.adapter.sendMessage({
    chatId: input.chatId,
    text: input.text,
    correlationId: input.correlationId,
  });

  return outbound.status === 'failed' ? undefined : outbound.messageId ?? undefined;
};

export class LegacyOrchestrationEngine implements OrchestrationEngine {
  readonly id = 'legacy' as const;

  async buildTask(taskId: string, message: OrchestrationExecutionInput['message']) {
    return orchestratorService.buildTask(taskId, message);
  }

  async executeTask(input: OrchestrationExecutionInput): Promise<OrchestrationExecutionResult> {
    const { task, latestCheckpoint } = input;
    const channelAdapter = resolveChannelAdapter(input.message.channel);
    let statusMessageId = input.message.trace?.statusMessageId;
    const message = {
      ...input.message,
      trace: {
        ...input.message.trace,
      },
    };

    if (latestCheckpoint?.node === 'synthesis.complete') {
      const text =
        typeof latestCheckpoint.state.text === 'string'
          ? latestCheckpoint.state.text
          : 'Recovered from completed checkpoint';
      return {
        task,
        status: 'done',
        currentStep: 'synthesis.complete',
        latestSynthesis: text,
        runtimeMeta: {
          engine: 'legacy',
          node: 'synthesis.complete',
          stepHistory: ['synthesis.complete'],
          canonicalIntent: task.canonicalIntent,
        },
      };
    }

    try {
      if (message.channel === 'lark') {
        statusMessageId = await upsertLarkStatusMessage({
          adapter: channelAdapter,
          chatId: message.chatId,
          correlationId: task.taskId,
          statusMessageId,
          text: buildStatusText({
            taskId: task.taskId,
            messageId: message.messageId,
            executionMode: task.executionMode,
            plan: task.plan,
            phase: 'processing',
          }),
        });
        if (statusMessageId) {
          message.trace = {
            ...message.trace,
            statusMessageId,
          };
        }
      }

      const planStartIndex = resolvePlanStartIndex(task.plan, latestCheckpoint?.node);
      const stepHistory: string[] = [];

      for (const step of task.plan.slice(planStartIndex)) {
        await runtimeControlSignalsRepository.assertRunnableAtBoundary(task.taskId);
        await checkpointRepository.save(task.taskId, step, {
          step,
          channel: message.channel,
          messageId: message.messageId,
          chatId: message.chatId,
          chatType: message.chatType,
          timestamp: message.timestamp,
          userId: message.userId,
          text: message.text,
        });
        stepHistory.push(step);
        await sleep(100);
      }

      if (orchestratorService.requiresHumanConfirmation(message.text)) {
        const hitlAction = await hitlActionService.createPending({
          taskId: task.taskId,
          actionType: 'execute',
          summary: orchestratorService.buildHitlSummary(message.text),
          chatId: message.chatId,
        });

        await checkpointRepository.save(task.taskId, 'hitl.requested', {
          actionId: hitlAction.actionId,
          actionType: hitlAction.actionType,
          expiresAt: hitlAction.expiresAt,
        });
        stepHistory.push('hitl.requested');

        if (message.channel === 'lark' && statusMessageId) {
          statusMessageId = await upsertLarkStatusMessage({
            adapter: channelAdapter,
            chatId: message.chatId,
            correlationId: task.taskId,
            statusMessageId,
            text: buildStatusText({
              taskId: task.taskId,
              messageId: message.messageId,
              executionMode: task.executionMode,
              plan: task.plan,
              phase: 'awaiting_confirmation',
              detail: `Waiting for confirmation on action ${hitlAction.actionId}.`,
            }),
          });
        }

        await channelAdapter.sendMessage({
          chatId: message.chatId,
          text:
            `Confirmation required for write-intent request.\n` +
            `Action ID: ${hitlAction.actionId}\n` +
            `Reply with: CONFIRM ${hitlAction.actionId} or CANCEL ${hitlAction.actionId}\n` +
            `Expires at: ${hitlAction.expiresAt}`,
          correlationId: task.taskId,
        });

        const resolved = await hitlActionService.waitForResolution(hitlAction.actionId);
        await checkpointRepository.save(task.taskId, `hitl.${resolved.action.status}`, {
          actionId: resolved.action.actionId,
          status: resolved.action.status,
        });
        stepHistory.push(`hitl.${resolved.action.status}`);

        if (resolved.action.status !== 'confirmed') {
          const latestSynthesis =
            resolved.action.status === 'expired'
              ? 'Request cancelled because confirmation timed out.'
              : 'Request cancelled by user confirmation flow.';

          if (message.channel === 'lark' && statusMessageId) {
            statusMessageId = await upsertLarkStatusMessage({
              adapter: channelAdapter,
              chatId: message.chatId,
              correlationId: task.taskId,
              statusMessageId,
              text: buildStatusText({
                taskId: task.taskId,
                messageId: message.messageId,
                executionMode: task.executionMode,
                plan: task.plan,
                phase: 'cancelled',
                detail:
                  resolved.action.status === 'expired'
                    ? 'Confirmation window expired.'
                    : 'Cancelled by user confirmation flow.',
              }),
            });
          }

          await channelAdapter.sendMessage({
            chatId: message.chatId,
            text:
              resolved.action.status === 'expired'
                ? 'Request auto-cancelled: confirmation window expired.'
                : 'Request cancelled. No write action executed.',
            correlationId: task.taskId,
          });

          return {
            task,
            status: 'cancelled',
            currentStep: `hitl.${resolved.action.status}`,
            latestSynthesis,
            hitlAction: resolved.action,
            runtimeMeta: {
              engine: 'legacy',
              node: `hitl.${resolved.action.status}`,
              stepHistory,
              canonicalIntent: task.canonicalIntent,
            },
          };
        }

        if (message.channel === 'lark' && statusMessageId) {
          statusMessageId = await upsertLarkStatusMessage({
            adapter: channelAdapter,
            chatId: message.chatId,
            correlationId: task.taskId,
            statusMessageId,
            text: buildStatusText({
              taskId: task.taskId,
              messageId: message.messageId,
              executionMode: task.executionMode,
              plan: task.plan,
              phase: 'resuming',
              detail: `Confirmation received for action ${resolved.action.actionId}.`,
            }),
          });
        }

        await channelAdapter.sendMessage({
          chatId: message.chatId,
          text: 'Confirmation received. Resuming execution.',
          correlationId: task.taskId,
        });
      }

      await runtimeControlSignalsRepository.assertRunnableAtBoundary(task.taskId);

      let agentResults;
      try {
        agentResults = await orchestratorService.dispatchAgents(task, message);
      } catch (error) {
        const classified = classifyRuntimeError(error);
        logger.error('legacy.orchestration.dispatch_failed', {
          taskId: task.taskId,
          messageId: message.messageId,
          classified,
        });
        throw error;
      }

      await checkpointRepository.save(task.taskId, 'agent.dispatch.complete', {
        count: agentResults.length,
        failed: agentResults.some((result) => result.status === 'failed'),
        channel: message.channel,
        messageId: message.messageId,
        chatId: message.chatId,
        chatType: message.chatType,
        timestamp: message.timestamp,
        userId: message.userId,
        text: message.text,
      });
      stepHistory.push('agent.dispatch.complete');

      const synthesis = orchestratorService.synthesize(task, message, agentResults);
      await checkpointRepository.save(task.taskId, 'synthesis.complete', {
        status: synthesis.taskStatus,
        text: synthesis.text,
        channel: message.channel,
        messageId: message.messageId,
        chatId: message.chatId,
        chatType: message.chatType,
        timestamp: message.timestamp,
        userId: message.userId,
      });
      stepHistory.push('synthesis.complete');

      if (message.channel === 'lark' && statusMessageId) {
        statusMessageId = await upsertLarkStatusMessage({
          adapter: channelAdapter,
          chatId: message.chatId,
          correlationId: task.taskId,
          statusMessageId,
          text: buildStatusText({
            taskId: task.taskId,
            messageId: message.messageId,
            executionMode: task.executionMode,
            plan: task.plan,
            phase: synthesis.taskStatus === 'failed' ? 'failed' : 'processed',
          }),
        });
      }

      await channelAdapter.sendMessage({
        chatId: message.chatId,
        text: synthesis.text,
        correlationId: task.taskId,
      });

      return {
        task,
        status: synthesis.taskStatus,
        currentStep: task.plan[task.plan.length - 1],
        latestSynthesis: synthesis.text,
        agentResults,
        runtimeMeta: {
          engine: 'legacy',
          node: 'synthesis.complete',
          stepHistory,
          canonicalIntent: task.canonicalIntent,
        },
      };
    } catch (error) {
      if (message.channel === 'lark' && statusMessageId) {
        const classified = classifyRuntimeError(error);
        await upsertLarkStatusMessage({
          adapter: channelAdapter,
          chatId: message.chatId,
          correlationId: task.taskId,
          statusMessageId,
          text: buildStatusText({
            taskId: task.taskId,
            messageId: message.messageId,
            executionMode: task.executionMode,
            plan: task.plan,
            phase: 'failed',
            detail: `Error: ${classified.rawMessage ?? classified.classifiedReason}`,
          }),
        });
      }
      throw error;
    }
  }
}

export const legacyOrchestrationEngine = new LegacyOrchestrationEngine();
