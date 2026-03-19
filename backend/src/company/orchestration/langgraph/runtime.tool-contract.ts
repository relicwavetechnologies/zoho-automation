import type { ToolActionGroup } from '../../tools/tool-action-groups';

export type GraphToolCall = {
  id: string;
  toolId: string;
  actionGroup: ToolActionGroup;
  input: Record<string, unknown>;
  dedupeKey: string;
};

export type GraphToolResult =
  | {
    kind: 'success';
    summary: string;
    output: Record<string, unknown>;
    citations?: Array<Record<string, unknown>>;
  }
  | {
    kind: 'approval_required';
    summary: string;
    pendingAction: {
      toolId: string;
      actionGroup: Extract<ToolActionGroup, 'create' | 'update' | 'delete' | 'send' | 'execute'>;
      title: string;
      subject?: string;
      payload: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
  }
  | {
    kind: 'authorization_failed';
    summary: string;
    reason: string;
  }
  | {
    kind: 'validation_failed';
    summary: string;
    reason: string;
    details?: Record<string, unknown>;
  }
  | {
    kind: 'error';
    summary: string;
    retriable: boolean;
    reason: string;
    details?: Record<string, unknown>;
  };

