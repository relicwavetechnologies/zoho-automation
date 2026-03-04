import { logger } from '../../../utils/logger';
import { resolveChannelAdapter } from '../../channels';
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

export class LegacyOrchestrationEngine implements OrchestrationEngine {
  readonly id = 'legacy' as const;

  async buildTask(taskId: string, message: OrchestrationExecutionInput['message']) {
    return orchestratorService.buildTask(taskId, message);
  }

  async executeTask(input: OrchestrationExecutionInput): Promise<OrchestrationExecutionResult> {
    const { task, message, latestCheckpoint } = input;

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
        },
      };
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

      const channelAdapter = resolveChannelAdapter(message.channel);
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
          },
        };
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

    const channelAdapter = resolveChannelAdapter(message.channel);
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
      },
    };
  }
}

export const legacyOrchestrationEngine = new LegacyOrchestrationEngine();
