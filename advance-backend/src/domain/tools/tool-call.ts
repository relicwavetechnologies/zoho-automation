import type { ToolId } from '../../shared/ids';
import type { ToolActionGroup } from '../permissions/tool-action-group';

export interface ToolCall {
  readonly toolId: ToolId;
  readonly action: ToolActionGroup;
  readonly args: Record<string, unknown>;
  readonly correlationId: string;
}

export type ToolOutcomeStatus = 'success' | 'partial' | 'failed' | 'permission_denied';

export interface ToolOutcome {
  readonly toolId: ToolId;
  readonly action: ToolActionGroup;
  readonly status: ToolOutcomeStatus;
  readonly data: unknown;
  readonly durationMs: number;
  readonly error?: string;
}
