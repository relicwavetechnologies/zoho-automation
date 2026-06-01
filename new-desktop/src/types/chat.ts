import type { StatusEvent } from './status-events';

/** A gated shell command + its live terminal, rendered as a card in the chat. */
export interface TerminalBlock {
  callId: string;
  command: string;
  cwd: string;
  net: boolean;
  status: 'awaiting' | 'running' | 'done' | 'declined';
  output: string;
  exitCode?: number;
  durationMs?: number;
}

/**
 * One node in the assistant's single ordered timeline. Text, thoughts, tool
 * rows and terminal cards are interleaved in true arrival order (Cursor-style),
 * so the model's mid-run prose stays next to the command it describes.
 */
export type TimelineItem =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string; shimmer: boolean }
  | {
      kind: 'tool';
      id: string;            // toolCallId
      toolName: string;      // resolved real tool (e.g. zohoBooks), not 'call_tool'
      family: string;
      verb: string;
      arg?: string;
      status: 'running' | 'done' | 'error';
      shimmer: boolean;
      durationMs?: number;
      detail?: string;
    }
  | { kind: 'terminal'; id: string; block: TerminalBlock };

export interface ApprovalRequest {
  id: string;
  action: string;
  reason: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  approvers?: string[];
  resolvedBy?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  approval?: ApprovalRequest;
  streaming?: boolean;
  events?: StatusEvent[];
  /** Single ordered timeline: text / thoughts / tools / terminals, interleaved. */
  timeline?: TimelineItem[];
  /** True after the first user-facing text delta arrives. */
  hasContent?: boolean;
  /** Total work duration (message.started → completed), for "Worked for Ns". */
  workMs?: number;
}

export interface Thread {
  id: string;
  title: string | null;
  workspaceId: string | null;
  workspaceName?: string | null;
  workspacePath?: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  messages: ChatMessage[];
}
