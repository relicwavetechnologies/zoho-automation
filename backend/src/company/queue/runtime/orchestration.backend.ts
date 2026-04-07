import { logger } from '../../../utils/logger';

export type OrchestrationQueueBackendMode = 'redis' | 'memory';

let backendMode: OrchestrationQueueBackendMode = 'redis';

export const getOrchestrationQueueBackendMode = (): OrchestrationQueueBackendMode => backendMode;

export const isMemoryQueueBackend = (): boolean => backendMode === 'memory';

export const setOrchestrationQueueBackendMode = (
  mode: OrchestrationQueueBackendMode,
  reason?: string,
): void => {
  if (backendMode === mode) {
    return;
  }

  const previousMode = backendMode;
  backendMode = mode;
  logger.warn('orchestration.queue.backend.changed', {
    previousMode,
    mode,
    reason: reason ?? null,
  });
};
