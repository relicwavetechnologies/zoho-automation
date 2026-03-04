import config from '../../../config';
import { logger } from '../../../utils/logger';
import { classifyRuntimeError } from '../../observability';
import { langGraphOrchestrationEngine } from './langgraph-orchestration.engine';
import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import type { OrchestrationEngine, OrchestrationEngineId, OrchestrationExecutionInput, OrchestrationExecutionResult } from './types';

const resolveEngineId = (): OrchestrationEngineId => (config.ORCHESTRATION_ENGINE === 'legacy' ? 'legacy' : 'langgraph');

export const getConfiguredOrchestrationEngineId = (): OrchestrationEngineId => resolveEngineId();

export const getOrchestrationEngine = (engineId: OrchestrationEngineId): OrchestrationEngine =>
  engineId === 'legacy' ? legacyOrchestrationEngine : langGraphOrchestrationEngine;

export const getConfiguredOrchestrationEngine = (): OrchestrationEngine => getOrchestrationEngine(resolveEngineId());

export const buildTaskWithConfiguredEngine = async (
  taskId: string,
  message: OrchestrationExecutionInput['message'],
) => {
  const engine = getConfiguredOrchestrationEngine();

  try {
    return await engine.buildTask(taskId, message);
  } catch (error) {
    if (engine.id !== 'langgraph' || !config.ORCHESTRATION_LEGACY_ROLLBACK_ENABLED) {
      throw error;
    }

    logger.warn('orchestration.engine.build.rollback_to_legacy', {
      taskId,
      configuredEngine: engine.id,
      reason: classifyRuntimeError(error),
    });
    return legacyOrchestrationEngine.buildTask(taskId, message);
  }
};

export type EngineExecutionEnvelope = {
  result: OrchestrationExecutionResult;
  engineUsed: OrchestrationEngineId;
  rolledBackFrom?: OrchestrationEngineId;
};

export const executeTaskWithConfiguredEngine = async (
  input: OrchestrationExecutionInput,
): Promise<EngineExecutionEnvelope> => {
  const engine = getConfiguredOrchestrationEngine();

  try {
    const result = await engine.executeTask(input);
    return {
      result,
      engineUsed: engine.id,
    };
  } catch (error) {
    if (engine.id !== 'langgraph' || !config.ORCHESTRATION_LEGACY_ROLLBACK_ENABLED) {
      throw error;
    }

    const classified = classifyRuntimeError(error);
    logger.error('orchestration.engine.execute.langgraph_failed', {
      taskId: input.task.taskId,
      messageId: input.message.messageId,
      configuredEngine: engine.id,
      rollbackTo: 'legacy',
      reason: classified,
    });

    const result = await legacyOrchestrationEngine.executeTask(input);
    return {
      result,
      engineUsed: 'legacy',
      rolledBackFrom: 'langgraph',
    };
  }
};

export * from './types';
