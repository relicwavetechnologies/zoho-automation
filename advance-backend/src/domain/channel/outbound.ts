export interface InteractiveAction {
  readonly label: string;
  readonly value: string;
  readonly style?: 'primary' | 'danger' | 'default';
}

export interface StatusUpdate {
  readonly kind: 'status';
  readonly text: string;
  readonly actions?: readonly InteractiveAction[];
  /** true = this is the last status before the final reply is sent */
  readonly terminal: boolean;
}

export interface FinalReply {
  readonly kind: 'final';
  readonly text: string;
  readonly format: 'text' | 'markdown' | 'interactive_card';
  readonly actions?: readonly InteractiveAction[];
  readonly attachments?: readonly { url: string; label?: string }[];
}

export type OutboundEvent = StatusUpdate | FinalReply;
