export type TurnRole = 'user' | 'assistant' | 'tool';

export interface Turn {
  readonly id: string;
  readonly role: TurnRole;
  readonly content: string;
  readonly timestamp: string;     // ISO 8601
  readonly toolName?: string;     // for role='tool'
  readonly toolOutcome?: unknown; // for role='tool'
}

export interface ConversationWindow {
  readonly turns: readonly Turn[];
  readonly truncated: boolean;
  readonly tokenEstimate: number;
  /** Pre-built structured summary of older turns (from background summarization). */
  readonly summary?: string;
}
