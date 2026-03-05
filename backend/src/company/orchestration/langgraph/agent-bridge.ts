import { randomUUID } from 'crypto';

import { logger } from '../../../utils/logger';
import { agentRegistry } from '../../agents';
import type { AgentInvokeInputDTO, AgentResultDTO, NormalizedIncomingMessageDTO, OrchestrationTaskDTO } from '../../contracts';
import { classifyRuntimeError } from '../../observability';

export type AgentBridgeReasonCode =
  | 'agent_not_registered'
  | 'agent_non_retriable_failure'
  | 'agent_retriable_failure'
  | 'agent_retry_exhausted'
  | 'agent_bridge_exception';

const normalizeFailureReasonCode = (
  result: AgentResultDTO,
): { reasonCode: AgentBridgeReasonCode; retriable: boolean; rawMessage?: string } => {
  if (result.error?.classifiedReason === 'agent_not_registered') {
    return {
      reasonCode: 'agent_not_registered',
      retriable: false,
      rawMessage: result.error.rawMessage,
    };
  }

  if (result.error?.retriable) {
    return {
      reasonCode: 'agent_retriable_failure',
      retriable: true,
      rawMessage: result.error.rawMessage,
    };
  }

  return {
    reasonCode: 'agent_non_retriable_failure',
    retriable: false,
    rawMessage: result.error?.rawMessage,
  };
};

const readAgentKeysFromPlan = (plan: string[]): string[] =>
  plan
    .filter((step) => step.startsWith('agent.invoke.'))
    .map((step) => step.replace('agent.invoke.', '').trim())
    .filter((step) => step.length > 0);

export const buildLangGraphAgentInvocations = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
): AgentInvokeInputDTO[] => {
  const agentKeys = readAgentKeysFromPlan(task.plan);

  return agentKeys.map((agentKey) => ({
    taskId: task.taskId,
    agentKey,
    objective: message.text,
    constraints: ['v1-langgraph-runtime'],
    contextPacket: {
      channel: message.channel,
      chatId: message.chatId,
      chatType: message.chatType,
      timestamp: message.timestamp,
      requestId: message.trace?.requestId,
      eventId: message.trace?.eventId,
      textHash: message.trace?.textHash,
    },
    correlationId: randomUUID(),
  }));
};

export const dispatchLangGraphAgents = async (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  invocations: AgentInvokeInputDTO[];
  attempt: number;
}): Promise<AgentResultDTO[]> => {
  const normalizedAttempt = Math.max(1, input.attempt);
  const results: AgentResultDTO[] = [];

  for (const invocation of input.invocations) {
    logger.debug('langgraph.agent.dispatch.start', {
      taskId: input.task.taskId,
      messageId: input.message.messageId,
      agentKey: invocation.agentKey,
      attempt: normalizedAttempt,
      correlationId: invocation.correlationId,
    });

    try {
      const candidate = await agentRegistry.invoke(invocation);

      if (candidate.status !== 'failed') {
        results.push({
          ...candidate,
          metrics: {
            ...(candidate.metrics ?? {}),
            apiCalls: normalizedAttempt,
          },
        });
        continue;
      }

      const failure = normalizeFailureReasonCode(candidate);
      results.push({
        ...candidate,
        error: {
          type: candidate.error?.type ?? 'TOOL_ERROR',
          classifiedReason: failure.reasonCode,
          rawMessage: failure.rawMessage,
          retriable: failure.retriable,
        },
        metrics: {
          ...(candidate.metrics ?? {}),
          apiCalls: normalizedAttempt,
        },
      });
    } catch (error) {
      const classified = classifyRuntimeError(error);
      results.push({
        taskId: input.task.taskId,
        agentKey: invocation.agentKey,
        status: 'failed',
        message: `Agent bridge exception for ${invocation.agentKey}`,
        error: {
          type: classified.type,
          classifiedReason: 'agent_bridge_exception',
          rawMessage: classified.rawMessage,
          retriable: classified.retriable,
        },
        metrics: {
          apiCalls: normalizedAttempt,
        },
      });
    }

    logger.success('langgraph.agent.dispatch.finish', {
      taskId: input.task.taskId,
      messageId: input.message.messageId,
      agentKey: invocation.agentKey,
      attempt: normalizedAttempt,
      status: results[results.length - 1]?.status,
      reason: results[results.length - 1]?.error?.classifiedReason,
    });
  }

  return results;
};
