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

/** Compact summary of an agent result for inclusion in subsequent agent context packets. */
const summarizeResult = (result: AgentResultDTO): string => {
  if (result.status === 'failed') {
    return `failed: ${result.error?.classifiedReason ?? result.message}`;
  }
  if (result.result && typeof result.result === 'object') {
    const keys = Object.keys(result.result as Record<string, unknown>).slice(0, 4).join(', ');
    return `success (fields: ${keys})`;
  }
  return result.message ?? 'success';
};

export type PriorAgentResult = {
  agentKey: string;
  summary: string;
};

export const buildLangGraphAgentInvocations = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  priorResults?: AgentResultDTO[],
): AgentInvokeInputDTO[] => {
  const agentKeys = readAgentKeysFromPlan(task.plan);
  const priorSummaries: PriorAgentResult[] = (priorResults ?? []).map((r) => ({
    agentKey: r.agentKey,
    summary: summarizeResult(r),
  }));

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
      companyId: message.trace?.companyId,
      larkTenantKey: message.trace?.larkTenantKey,
      requestId: message.trace?.requestId,
      eventId: message.trace?.eventId,
      textHash: message.trace?.textHash,
      ...(priorSummaries.length > 0 ? { priorAgentResults: priorSummaries } : {}),
    },
    correlationId: randomUUID(),
  }));
};

/** Build invocation for a single agent (used by supervisor loop, one at a time). */
export const buildSingleAgentInvocation = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  agentKey: string,
  priorResults?: AgentResultDTO[],
): AgentInvokeInputDTO => {
  const priorSummaries: PriorAgentResult[] = (priorResults ?? []).map((r) => ({
    agentKey: r.agentKey,
    summary: summarizeResult(r),
  }));

  return {
    taskId: task.taskId,
    agentKey,
    objective: message.text,
    constraints: ['v1-langgraph-runtime'],
    contextPacket: {
      channel: message.channel,
      chatId: message.chatId,
      chatType: message.chatType,
      timestamp: message.timestamp,
      companyId: message.trace?.companyId,
      larkTenantKey: message.trace?.larkTenantKey,
      requestId: message.trace?.requestId,
      eventId: message.trace?.eventId,
      textHash: message.trace?.textHash,
      ...(priorSummaries.length > 0 ? { priorAgentResults: priorSummaries } : {}),
    },
    correlationId: randomUUID(),
  };
};

/** Sequential dispatch (existing behavior — unchanged for backward compat). */
export const dispatchLangGraphAgents = async (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  invocations: AgentInvokeInputDTO[];
  attempt: number;
}): Promise<AgentResultDTO[]> => {
  const normalizedAttempt = Math.max(1, input.attempt);
  const results: AgentResultDTO[] = [];

  for (const invocation of input.invocations) {
    console.log(`\n[AGENT:${invocation.agentKey}] 🚀 Dispatching agent for task ${input.task.taskId.slice(0, 8)}...`);
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

    const finalStatus = results[results.length - 1]?.status;
    const finalReason = results[results.length - 1]?.error?.classifiedReason;
    if (finalStatus === 'failed') {
      console.log(`[AGENT:${invocation.agentKey}] ❌ Failed: ${finalReason}`);
    } else {
      console.log(`[AGENT:${invocation.agentKey}] ✅ Success.`);
    }

    logger.success('langgraph.agent.dispatch.finish', {
      taskId: input.task.taskId,
      messageId: input.message.messageId,
      agentKey: invocation.agentKey,
      attempt: normalizedAttempt,
      status: finalStatus,
      reason: finalReason,
    });
  }

  return results;
};

/**
 * Parallel dispatch via Promise.allSettled — used when executionMode === 'parallel'.
 * All agents run concurrently; settled results are collected regardless of individual failures.
 */
export const dispatchLangGraphAgentsParallel = async (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  invocations: AgentInvokeInputDTO[];
  attempt: number;
}): Promise<AgentResultDTO[]> => {
  const normalizedAttempt = Math.max(1, input.attempt);

  const settled = await Promise.allSettled(
    input.invocations.map(async (invocation) => {
      console.log(`\n[AGENT:${invocation.agentKey}] 🚀 (Parallel) Dispatching agent...`);
      logger.debug('langgraph.agent.parallel.dispatch.start', {
        taskId: input.task.taskId,
        agentKey: invocation.agentKey,
        attempt: normalizedAttempt,
      });
      return agentRegistry.invoke(invocation);
    }),
  );

  return settled.map((outcome, idx) => {
    const invocation = input.invocations[idx]!;
    if (outcome.status === 'fulfilled') {
      const candidate = outcome.value;
      if (candidate.status !== 'failed') {
        console.log(`[AGENT:${invocation.agentKey}] ✅ Success.`);
        logger.success('langgraph.agent.parallel.dispatch.finish', {
          taskId: input.task.taskId,
          agentKey: invocation.agentKey,
          status: 'success',
        });
        return { ...candidate, metrics: { ...(candidate.metrics ?? {}), apiCalls: normalizedAttempt } };
      }
      const failure = normalizeFailureReasonCode(candidate);
      return {
        ...candidate,
        error: {
          type: candidate.error?.type ?? 'TOOL_ERROR',
          classifiedReason: failure.reasonCode,
          rawMessage: failure.rawMessage,
          retriable: failure.retriable,
        },
        metrics: { ...(candidate.metrics ?? {}), apiCalls: normalizedAttempt },
      };
    }
    // Rejected promise (uncaught exception in the invoke)
    const classified = classifyRuntimeError(outcome.reason);
    console.log(`[AGENT:${invocation.agentKey}] ❌ Exception: ${classified.classifiedReason}`);
    logger.warn('langgraph.agent.parallel.dispatch.exception', {
      taskId: input.task.taskId,
      agentKey: invocation.agentKey,
      reason: classified.classifiedReason,
    });
    return {
      taskId: input.task.taskId,
      agentKey: invocation.agentKey,
      status: 'failed' as const,
      message: `Parallel agent exception for ${invocation.agentKey}`,
      error: {
        type: classified.type,
        classifiedReason: 'agent_bridge_exception' as AgentBridgeReasonCode,
        rawMessage: classified.rawMessage,
        retriable: classified.retriable,
      },
      metrics: { apiCalls: normalizedAttempt },
    };
  });
};

/** Dispatches a single agent in the supervisor loop. */
export const dispatchSingleAgent = async (input: {
  task: OrchestrationTaskDTO;
  message: NormalizedIncomingMessageDTO;
  agentKey: string;
  priorResults: AgentResultDTO[];
  attempt: number;
}): Promise<AgentResultDTO> => {
  const invocation = buildSingleAgentInvocation(input.task, input.message, input.agentKey, input.priorResults);
  const results = await dispatchLangGraphAgents({
    task: input.task,
    message: input.message,
    invocations: [invocation],
    attempt: input.attempt,
  });
  return results[0]!;
};
