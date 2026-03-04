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
import {
  buildHitlSummary,
  buildPlanFromIntent,
  classifyComplexityLevel,
  detectRouteIntent,
  requiresHumanConfirmation,
  synthesizeFromAgentResults,
} from './routing-heuristics';

export class OrchestratorService {
  requiresHumanConfirmation(messageText: string): boolean {
    return requiresHumanConfirmation(messageText);
  }

  buildHitlSummary(messageText: string): string {
    return buildHitlSummary(messageText);
  }

  async buildTask(taskId: string, message: NormalizedIncomingMessageDTO): Promise<OrchestrationTaskDTO> {
    const complexityLevel = classifyComplexityLevel(message.text);
    const intent = detectRouteIntent(message.text);
    return {
      taskId,
      messageId: message.messageId,
      userId: message.userId,
      chatId: message.chatId,
      status: 'running',
      complexityLevel,
      orchestratorModel: 'v0-rule-router',
      plan: buildPlanFromIntent(intent, complexityLevel, message.text),
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

      logger.debug('orchestration.agent.dispatch.start', {
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

      logger.success('orchestration.agent.dispatch.finish', {
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
    return synthesizeFromAgentResults(task, message, agentResults);
  }
}

export const orchestratorService = new OrchestratorService();
