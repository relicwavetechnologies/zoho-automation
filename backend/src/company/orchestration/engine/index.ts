import config from '../../../config';
import { logger } from '../../../utils/logger';
import { classifyRuntimeError } from '../../observability';
import { langGraphOrchestrationEngine } from './langgraph-orchestration.engine';
import { mastraOrchestrationEngine } from './mastra-orchestration.engine';
import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import type {
  OrchestrationEngine,
  OrchestrationEngineId,
  OrchestrationExecutionInput,
  OrchestrationExecutionResult,
  RollbackDecision,
} from './types';

const resolveEngineId = (): OrchestrationEngineId => {
  if (config.ORCHESTRATION_ENGINE === 'legacy') {
    return 'legacy';
  }
  if (config.ORCHESTRATION_ENGINE === 'mastra') {
    return 'mastra';
  }
  return 'langgraph';
};

export const resolveEnginePolicy = () => ({
  configuredEngine: resolveEngineId(),
  rollbackEnabled: Boolean(config.ORCHESTRATION_LEGACY_ROLLBACK_ENABLED),
});

export const classifyRollbackEligibility = (error: unknown): RollbackDecision => {
  const classified = classifyRuntimeError(error);
  const reason = classified.classifiedReason.toLowerCase();
  const message = classified.rawMessage?.toLowerCase() ?? '';

  if (reason.includes('network') || reason.includes('timeout') || message.includes('rate limit')) {
    return {
      eligible: true,
      reasonCode: 'llm_unavailable',
    };
  }

  if (reason.includes('json') || reason.includes('schema') || message.includes('json') || message.includes('parse')) {
    return {
      eligible: true,
      reasonCode: 'llm_invalid_output',
    };
  }

  if (reason.includes('checkpoint') || message.includes('checkpoint') || message.includes('redis')) {
    return {
      eligible: true,
      reasonCode: 'checkpoint_io',
    };
  }

  if (reason.includes('agent') || reason.includes('tool') || message.includes('agent')) {
    return {
      eligible: true,
      reasonCode: 'agent_runtime',
    };
  }

  if (classified.type === 'UNKNOWN_ERROR') {
    return {
      eligible: true,
      reasonCode: 'unknown',
    };
  }

  return {
    eligible: false,
    reasonCode: 'non_eligible',
  };
};

export const getConfiguredOrchestrationEngineId = (): OrchestrationEngineId => resolveEngineId();

export const getOrchestrationEngine = (engineId: OrchestrationEngineId): OrchestrationEngine =>
  engineId === 'legacy'
    ? legacyOrchestrationEngine
    : engineId === 'mastra'
      ? mastraOrchestrationEngine
      : langGraphOrchestrationEngine;

export const getConfiguredOrchestrationEngine = (): OrchestrationEngine => getOrchestrationEngine(resolveEngineId());

export const buildTaskWithConfiguredEngine = async (
  taskId: string,
  message: OrchestrationExecutionInput['message'],
) => {
  const policy = resolveEnginePolicy();
  const engine = getOrchestrationEngine(policy.configuredEngine);
  logger.info('orchestration.engine.selection', {
    taskId,
    messageId: message.messageId,
    configuredEngine: policy.configuredEngine,
    rollbackEnabled: policy.rollbackEnabled,
  });

  try {
    return await engine.buildTask(taskId, message);
  } catch (error) {
    const rollback = classifyRollbackEligibility(error);
    if (engine.id !== 'langgraph' || !policy.rollbackEnabled || !rollback.eligible) {
      logger.warn('orchestration.engine.rollback.skipped', {
        taskId,
        messageId: message.messageId,
        configuredEngine: policy.configuredEngine,
        rollbackEnabled: policy.rollbackEnabled,
        rollbackReasonCode: rollback.reasonCode,
        reason: classifyRuntimeError(error),
      });
      throw error;
    }

    logger.warn('orchestration.engine.rollback.eligible', {
      taskId,
      messageId: message.messageId,
      configuredEngine: policy.configuredEngine,
      rollbackEnabled: policy.rollbackEnabled,
      rollbackReasonCode: rollback.reasonCode,
      reason: classifyRuntimeError(error),
    });
    logger.warn('orchestration.engine.build.rollback_to_legacy', {
      taskId,
      messageId: message.messageId,
      configuredEngine: engine.id,
      rollbackEnabled: policy.rollbackEnabled,
      rollbackReasonCode: rollback.reasonCode,
      reason: classifyRuntimeError(error),
    });
    return legacyOrchestrationEngine.buildTask(taskId, message);
  }
};

export type EngineExecutionEnvelope = {
  configuredEngine: OrchestrationEngineId;
  result: OrchestrationExecutionResult;
  engineUsed: OrchestrationEngineId;
  rolledBackFrom?: OrchestrationEngineId;
  rollbackReasonCode?: RollbackDecision['reasonCode'];
};

export const executeTaskWithConfiguredEngine = async (
  input: OrchestrationExecutionInput,
): Promise<EngineExecutionEnvelope> => {
  const policy = resolveEnginePolicy();
  const engine = getOrchestrationEngine(policy.configuredEngine);
  logger.info('orchestration.engine.selection', {
    taskId: input.task.taskId,
    messageId: input.message.messageId,
    configuredEngine: policy.configuredEngine,
    rollbackEnabled: policy.rollbackEnabled,
  });

  try {
    const result = await engine.executeTask(input);
    return {
      configuredEngine: policy.configuredEngine,
      result,
      engineUsed: engine.id,
    };
  } catch (error) {
    const rollback = classifyRollbackEligibility(error);
    if (engine.id !== 'langgraph' || !policy.rollbackEnabled || !rollback.eligible) {
      logger.warn('orchestration.engine.rollback.skipped', {
        taskId: input.task.taskId,
        messageId: input.message.messageId,
        configuredEngine: policy.configuredEngine,
        rollbackEnabled: policy.rollbackEnabled,
        rollbackReasonCode: rollback.reasonCode,
        reason: classifyRuntimeError(error),
      });
      throw error;
    }

    const classified = classifyRuntimeError(error);
    logger.warn('orchestration.engine.rollback.eligible', {
      taskId: input.task.taskId,
      messageId: input.message.messageId,
      configuredEngine: policy.configuredEngine,
      rollbackEnabled: policy.rollbackEnabled,
      rollbackReasonCode: rollback.reasonCode,
      reason: classified,
    });
    logger.error('orchestration.engine.execute.langgraph_failed', {
      taskId: input.task.taskId,
      messageId: input.message.messageId,
      configuredEngine: policy.configuredEngine,
      rollbackEnabled: policy.rollbackEnabled,
      rollbackTo: 'legacy',
      rollbackReasonCode: rollback.reasonCode,
      reason: classified,
    });

    const result = await legacyOrchestrationEngine.executeTask(input);
    logger.warn('orchestration.engine.rollback.executed', {
      taskId: input.task.taskId,
      messageId: input.message.messageId,
      configuredEngine: policy.configuredEngine,
      engineUsed: 'legacy',
      rolledBackFrom: 'langgraph',
      rollbackEnabled: policy.rollbackEnabled,
      rollbackReasonCode: rollback.reasonCode,
    });
    return {
      configuredEngine: policy.configuredEngine,
      result,
      engineUsed: 'legacy',
      rolledBackFrom: 'langgraph',
      rollbackReasonCode: rollback.reasonCode,
    };
  }
};

export * from './types';
