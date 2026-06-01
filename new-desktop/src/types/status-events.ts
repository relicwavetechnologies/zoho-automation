/**
 * Status event vocabulary for the *desktop* channel.
 * Lark uses a completely separate set — branched at StatusChannel.emit() in
 * the orchestration engine.
 *
 * Contract owner: this file is the canonical client-side type. The backend
 * desktop-ws.gateway must emit matching JSON shapes.
 */

export type StatusEventKind =
  | 'message.started'
  | 'message.delta'
  | 'message.completed'
  | 'plan'
  | 'tool.start'
  | 'tool.progress'
  | 'tool.done'
  | 'tool.error'
  | 'file.read'
  | 'file.write'
  | 'approval.required'
  | 'approval.resolved'
  | 'thinking'
  | 'terminal.request'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed';

interface BaseEvent {
  kind: StatusEventKind;
  threadId: string;
  runId: string;
  sequence: number;
  at: string; // ISO timestamp
}

export interface MessageStartedEvent extends BaseEvent {
  kind: 'message.started';
  messageId: string;
  model?: string;
}

export interface MessageDeltaEvent extends BaseEvent {
  kind: 'message.delta';
  messageId: string;
  delta: string;
}

export interface MessageCompletedEvent extends BaseEvent {
  kind: 'message.completed';
  messageId: string;
  content: string;
  tokensUsed?: number;
}

export interface PlanEventStep {
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  title: string;
  subtitle?: string;
  toolFamily?: string;
}

export interface PlanEvent extends BaseEvent {
  kind: 'plan';
  summary: string;
  steps?: PlanEventStep[];
}

export interface ToolStartEvent extends BaseEvent {
  kind: 'tool.start';
  toolCallId: string;
  toolName: string;
  family: string;
  args?: Record<string, unknown>;
  summary?: string;
  /** Present-progressive verb from backend tool-labels (e.g. "Reading Zoho Books…"). */
  verb?: string;
}

export interface ToolProgressEvent extends BaseEvent {
  kind: 'tool.progress';
  toolCallId: string;
  message: string;
  progress?: { current: number; total?: number };
}

export interface ToolDoneEvent extends BaseEvent {
  kind: 'tool.done';
  toolCallId: string;
  summary: string;
  durationMs?: number;
  outputPreview?: string;
  /** Past-tense verb from backend tool-labels (e.g. "Read", "Searched"). */
  past?: string;
}

export interface ToolErrorEvent extends BaseEvent {
  kind: 'tool.error';
  toolCallId: string;
  error: { code: string; message: string };
}

export interface FileReadEvent extends BaseEvent {
  kind: 'file.read';
  path: string;
  lines?: { start: number; end: number };
}

export interface FileWriteEvent extends BaseEvent {
  kind: 'file.write';
  path: string;
  diff?: string;
  additions: number;
  deletions: number;
}

export interface ApprovalRequiredEvent extends BaseEvent {
  kind: 'approval.required';
  approvalId: string;
  reason: string;
  action: string;
  payload: Record<string, unknown>;
  approvers?: string[];
}

export interface ApprovalResolvedEvent extends BaseEvent {
  kind: 'approval.resolved';
  approvalId: string;
  decision: 'approved' | 'rejected';
  resolvedBy: string;
}

export interface ThinkingEvent extends BaseEvent {
  kind: 'thinking';
  message: string;
}

export interface TerminalRequestEvent extends BaseEvent {
  kind: 'terminal.request';
  callId: string;
  command: string;
  cwd: string;
  net: boolean;
  timeoutMs?: number;
}

export interface RunCompletedEvent extends BaseEvent {
  kind: 'run.completed';
  durationMs: number;
  toolsUsed: number;
  tokensUsed?: number;
}

export interface RunCancelledEvent extends BaseEvent {
  kind: 'run.cancelled';
  reason: string;
}

export interface RunFailedEvent extends BaseEvent {
  kind: 'run.failed';
  error: { code: string; message: string };
}

export type StatusEvent =
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | PlanEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolDoneEvent
  | ToolErrorEvent
  | FileReadEvent
  | FileWriteEvent
  | ApprovalRequiredEvent
  | ApprovalResolvedEvent
  | ThinkingEvent
  | TerminalRequestEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | RunFailedEvent;
