import type { RuntimeChannel } from './runtime.types';

export const buildRuntimeConversationKey = (input: {
  channel: RuntimeChannel;
  threadId?: string | null;
  chatId?: string | null;
}): string => {
  if (input.channel === 'desktop') {
    const threadId = input.threadId?.trim();
    if (!threadId) {
      throw new Error('Desktop runtime conversations require a threadId.');
    }
    return `desktop:${threadId}`;
  }

  const chatId = input.chatId?.trim();
  if (!chatId) {
    throw new Error('Lark runtime conversations require a chatId.');
  }
  return `lark:${chatId}`;
};

export const buildRuntimeRawChannelKey = (input: {
  channel: RuntimeChannel;
  threadId?: string | null;
  chatId?: string | null;
}): string => {
  if (input.channel === 'desktop') {
    const threadId = input.threadId?.trim();
    if (!threadId) {
      throw new Error('Desktop runtime conversations require a threadId.');
    }
    return threadId;
  }

  const chatId = input.chatId?.trim();
  if (!chatId) {
    throw new Error('Lark runtime conversations require a chatId.');
  }
  return chatId;
};

