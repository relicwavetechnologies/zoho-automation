import type { AgentInvokeInputDTO } from '../../contracts';
import { resolveChannelAdapter } from '../../channels';
import { BaseAgent } from '../base';

const readContextString = (input: AgentInvokeInputDTO, key: string): string | undefined => {
  const value = input.contextPacket[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export class LarkResponseAgent extends BaseAgent {
  readonly key = 'lark-response';

  async invoke(input: AgentInvokeInputDTO) {
    const channel = readContextString(input, 'channel');
    const chatId = readContextString(input, 'chatId');

    if (!channel || !chatId) {
      return this.failure(
        input,
        'Missing channel/chat context for response delivery',
        'missing_channel_context',
      );
    }

    if (channel !== 'lark') {
      return this.failure(
        input,
        `Unsupported response channel: ${channel}`,
        'unsupported_response_channel',
      );
    }

    const adapter = resolveChannelAdapter('lark');
    const progressText = `Processing request (${input.taskId.slice(0, 8)})...`;
    const outbound = await adapter.sendMessage({
      chatId,
      text: progressText,
      correlationId: input.correlationId,
    });

    if (outbound.status === 'failed') {
      return this.failure(
        input,
        'Lark response delivery failed',
        outbound.error?.classifiedReason ?? 'lark_send_failed',
        outbound.error?.rawMessage,
        outbound.error?.retriable ?? false,
      );
    }

    return this.success(
      input,
      'Lark progress response delivered',
      {
        chatId,
        channel,
        messageId: outbound.messageId ?? null,
      },
      { latencyMs: 4, apiCalls: 1 },
    );
  }
}
