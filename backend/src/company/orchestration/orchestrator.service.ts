import { randomUUID } from 'crypto';

import config from '../../config';
import { logger } from '../../utils/logger';
import { agentRegistry } from '../agents';
import type {
  AgentInvokeInputDTO,
  AgentResultDTO,
  NormalizedIncomingMessageDTO,
  OrchestrationTaskDTO,
} from '../contracts';
import { classifyRuntimeError, runWithRetryPolicy } from '../observability';

const classifyComplexityLevel = (text: string): 1 | 2 | 3 | 4 | 5 => {
  const normalized = text.toLowerCase();
  if (normalized.includes('delete') || normalized.includes('remove') || normalized.includes('write')) {
    return 4;
  }
  if (normalized.includes('sync') || normalized.includes('onboard') || normalized.includes('workflow')) {
    return 3;
  }
  if (normalized.trim().length <= 40) {
    return 1;
  }
  return 2;
};

const WRITE_INTENT_KEYWORDS = ['delete', 'remove', 'drop', 'overwrite', 'destroy', 'write'];

const buildPlan = (complexityLevel: 1 | 2 | 3 | 4 | 5, text: string): string[] => {
  const normalized = text.toLowerCase();
  const asksZoho = normalized.includes('zoho') || normalized.includes('deal') || normalized.includes('contact');
  const base = complexityLevel >= 4
    ? ['route.classify', 'agent.invoke.risk-check', 'agent.invoke.response', 'agent.invoke.lark-response', 'synthesis.compose']
    : ['route.classify', 'agent.invoke.response', 'agent.invoke.lark-response', 'synthesis.compose'];

  if (asksZoho) {
    return ['route.classify', 'agent.invoke.zoho-read', 'agent.invoke.lark-response', 'synthesis.compose'];
  }

  if (normalized.includes('unknown_agent')) {
    return ['route.classify', 'agent.invoke.unknown', 'synthesis.compose'];
  }

  return base;
};

export class OrchestratorService {
  requiresHumanConfirmation(messageText: string): boolean {
    const normalized = messageText.toLowerCase();
    return WRITE_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  buildHitlSummary(messageText: string): string {
    const summary = messageText.trim();
    if (summary.length <= 160) {
      return summary;
    }
    return `${summary.slice(0, 157)}...`;
  }

  async buildTask(taskId: string, message: NormalizedIncomingMessageDTO): Promise<OrchestrationTaskDTO> {
    const complexityLevel = classifyComplexityLevel(message.text);
    return {
      taskId,
      messageId: message.messageId,
      userId: message.userId,
      chatId: message.chatId,
      status: 'running',
      complexityLevel,
      orchestratorModel: 'v0-rule-router',
      plan: buildPlan(complexityLevel, message.text),
      executionMode: 'sequential',
    };
  }

  async dispatchAgents(task: OrchestrationTaskDTO, message: NormalizedIncomingMessageDTO): Promise<AgentResultDTO[]> {
    const agentKeys = task.plan
      .filter((step) => step.startsWith('agent.invoke.'))
      .map((step) => step.replace('agent.invoke.', ''));

    const results: AgentResultDTO[] = [];
    for (const agentKey of agentKeys) {
      const invokeInput: AgentInvokeInputDTO = {
        taskId: task.taskId,
        agentKey,
        objective: message.text,
        constraints: ['v0-safe-routing'],
        contextPacket: {
          channel: message.channel,
          chatId: message.chatId,
          chatType: message.chatType,
          timestamp: message.timestamp,
        },
        correlationId: randomUUID(),
      };

      logger.info('orchestration.agent.dispatch.start', {
        taskId: task.taskId,
        messageId: task.messageId,
        agentKey,
      });

      let attemptCount = 1;
      try {
        const { result, attempts } = await runWithRetryPolicy({
          maxAttempts: config.RETRY_MAX_ATTEMPTS,
          baseDelayMs: config.RETRY_BASE_DELAY_MS,
          run: async () => agentRegistry.invoke(invokeInput),
          shouldRetry: (candidateResult, candidateError) => {
            if (candidateResult) {
              return candidateResult.status === 'failed' && !!candidateResult.error?.retriable;
            }
            if (candidateError) {
              const classified = classifyRuntimeError(candidateError);
              return classified.retriable;
            }
            return false;
          },
          onRetry: (attempt, retryError, retryResult, delayMs) => {
            const detail = retryResult
              ? { status: retryResult.status, error: retryResult.error?.classifiedReason }
              : { error: classifyRuntimeError(retryError).classifiedReason };
            logger.warn('orchestration.agent.dispatch.retry', {
              taskId: task.taskId,
              messageId: task.messageId,
              agentKey,
              attempt,
              delayMs,
              detail,
            });
          },
        });

        attemptCount = attempts;
        const decoratedResult: AgentResultDTO = {
          ...result,
          metrics: {
            ...(result.metrics ?? {}),
            apiCalls: attemptCount,
          },
        };
        results.push(decoratedResult);
      } catch (error) {
        const classified = classifyRuntimeError(error);
        results.push({
          taskId: task.taskId,
          agentKey,
          status: 'failed',
          message: `Agent dispatch failed: ${classified.classifiedReason}`,
          error: classified,
          metrics: { apiCalls: attemptCount },
        });
      }

      logger.info('orchestration.agent.dispatch.finish', {
        taskId: task.taskId,
        messageId: task.messageId,
        agentKey,
        status: results[results.length - 1]?.status,
        retriesUsed: Math.max(0, attemptCount - 1),
      });
    }

    return results;
  }

  synthesize(task: OrchestrationTaskDTO, message: NormalizedIncomingMessageDTO, agentResults: AgentResultDTO[]) {
    const failed = agentResults.find((result) => result.status === 'failed');
    if (failed) {
      return {
        taskStatus: 'failed' as const,
        text: `Request could not be completed: ${failed.message}`,
      };
    }

    const zohoResult = agentResults.find((result) => result.agentKey === 'zoho-read' && result.status === 'success');
    if (zohoResult?.result) {
      const count = typeof zohoResult.result.total === 'number' ? zohoResult.result.total : 'unknown';
      return {
        taskStatus: 'done' as const,
        text: `Zoho data read complete. Total records available: ${count}.`,
      };
    }

    return {
      taskStatus: 'done' as const,
      text: `Processed (${task.executionMode}) for message ${message.messageId}. Plan: ${task.plan.join(' -> ')}`,
    };
  }
}

export const orchestratorService = new OrchestratorService();
