import type { OrchestrationTaskStatus } from './status';

export const ORCHESTRATION_STATE_TRANSITIONS: ReadonlyArray<
  readonly [from: OrchestrationTaskStatus, to: OrchestrationTaskStatus]
> = [
  ['pending', 'running'],
  ['running', 'hitl'],
  ['hitl', 'running'],
  ['hitl', 'cancelled'],
  ['running', 'done'],
  ['running', 'failed'],
] as const;

export const canTransitionTaskStatus = (
  from: OrchestrationTaskStatus,
  to: OrchestrationTaskStatus,
): boolean => ORCHESTRATION_STATE_TRANSITIONS.some(([validFrom, validTo]) => validFrom === from && validTo === to);
