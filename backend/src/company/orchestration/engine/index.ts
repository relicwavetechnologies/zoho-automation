import config from '../../../config';
import { logger } from '../../../utils/logger';
import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import { vercelOrchestrationEngine } from './vercel-orchestration.engine';
import type {
  OrchestrationEngine,
  OrchestrationEngineId,
  OrchestrationExecutionInput,
  OrchestrationExecutionResult,
} from './types';

const resolveEngineId = (): OrchestrationEngineId => {
  if (config.ORCHESTRATION_ENGINE === 'vercel') {
    return 'vercel';
  }
  return 'legacy';
};

export const resolveEnginePolicy = () => ({
  configuredEngine: resolveEngineId(),
});

export const getConfiguredOrchestrationEngineId = (): OrchestrationEngineId => resolveEngineId();

export const getOrchestrationEngine = (engineId: OrchestrationEngineId): OrchestrationEngine =>
  engineId === 'vercel' ? vercelOrchestrationEngine : legacyOrchestrationEngine;

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
  });

  return engine.buildTask(taskId, message);
};

export type EngineExecutionEnvelope = {
  configuredEngine: OrchestrationEngineId;
  result: OrchestrationExecutionResult;
  engineUsed: OrchestrationEngineId;
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
  });

  const result = await engine.executeTask(input);
  return {
    configuredEngine: policy.configuredEngine,
    result,
    engineUsed: engine.id,
  };
};

export * from './types';
