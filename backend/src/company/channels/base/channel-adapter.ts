import type { ErrorDTO, NormalizedIncomingMessageDTO } from '../../contracts';

export type ChannelKey = 'lark' | 'slack' | 'whatsapp';

export type ChannelOutboundMessage = {
  chatId: string;
  text: string;
  correlationId?: string;
};

export type ChannelUpdateMessage = {
  messageId: string;
  text: string;
  correlationId?: string;
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
