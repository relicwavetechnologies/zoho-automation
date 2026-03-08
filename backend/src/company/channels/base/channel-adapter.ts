import type { ErrorDTO, NormalizedIncomingMessageDTO } from '../../contracts';

export type ChannelKey = 'lark' | 'slack' | 'whatsapp';

/**
 * A single interactive button to attach to a message card.
 */
export type ChannelAction = {
  /** Unique action identifier, e.g. "share_vectors". Used to route card action events. */
  id: string;
  /** Human-readable button label shown in the UI. */
  label: string;
  /** Arbitrary payload sent back when the button is clicked. */
  value: Record<string, unknown>;
  /** Visual style of the button. Defaults to "default". */
  style?: 'default' | 'primary' | 'danger';
};

export type ChannelOutboundMessage = {
  chatId: string;
  text: string;
  correlationId?: string;
  /** Optional interactive buttons to attach to the message card. */
  actions?: ChannelAction[];
};

export type ChannelUpdateMessage = {
  messageId: string;
  text: string;
  correlationId?: string;
  /** Optional interactive buttons to attach to the updated card. Pass empty array to remove. */
  actions?: ChannelAction[];
};

export type ChannelOutboundResult = {
  channel: ChannelKey;
  status: 'sent' | 'updated' | 'failed';
  chatId?: string;
  messageId?: string;
  providerResponse?: unknown;
  error?: ErrorDTO;
};

export interface ChannelAdapter {
  readonly channel: ChannelKey;
  normalizeIncomingEvent(event: unknown): Readonly<NormalizedIncomingMessageDTO> | null;
  sendMessage(input: ChannelOutboundMessage): Promise<ChannelOutboundResult>;
  updateMessage(input: ChannelUpdateMessage): Promise<ChannelOutboundResult>;
}
