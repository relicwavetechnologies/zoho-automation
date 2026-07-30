import type { ToolOutcome } from '../tools/tool-call';
import type { ToolError, OrchestrationError, PermissionError } from '../../shared/errors';

export type StepStatus = 'success' | 'partial' | 'failed' | 'skipped';

export interface StepResult {
  readonly stepId: string;
  readonly agentId: string;
  readonly status: StepStatus;
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly summary?: string;
  readonly error?: ToolError | OrchestrationError | PermissionError;
  readonly durationMs: number;
}

