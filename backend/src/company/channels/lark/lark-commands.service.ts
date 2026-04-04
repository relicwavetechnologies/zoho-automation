import type { LarkChannelAdapter } from './lark.adapter';
import { larkChatContextService } from './lark-chat-context.service';
import { createEmptyTaskState } from '../../../modules/desktop-chat/desktop-thread-memory';

export const handleLarkCommand = async (input: {
  commandText: string;
  chatId: string;
  companyId: string;
  threadRootId: string | null;
  adapter: Pick<LarkChannelAdapter, 'sendMessage'>;
  messageId: string;
}): Promise<{ responseText: string }> => {
  void input.adapter;
  void input.messageId;

  const [command, ...flags] = input.commandText.split(/\s+/);
  const clearMain = flags.includes('--main');
  const clearAll = flags.includes('--all');

  const clearTaskState = async (): Promise<void> => {
    await larkChatContextService.persistTaskState({
      companyId: input.companyId,
      chatId: input.chatId,
      chatType: 'group',
      taskState: {
        ...createEmptyTaskState(),
        supervisorProgress: null,
        workingSets: {},
        activeObjective: undefined,
        pendingApproval: null,
      },
    });
  };

  if (command === '/clear') {
    if (!input.threadRootId || clearAll) {
      await larkChatContextService.clearAllMessages({
        companyId: input.companyId,
        chatId: input.chatId,
      });
      await clearTaskState();
      return { responseText: '✓ Conversation history cleared.' };
    }

    if (!clearMain) {
      await larkChatContextService.clearThreadMessages({
        companyId: input.companyId,
        chatId: input.chatId,
        threadRootId: input.threadRootId,
      });
      await clearTaskState();
      return {
        responseText: '✓ Thread history cleared. Main conversation context is preserved.',
      };
    }

    await larkChatContextService.clearThreadMessages({
      companyId: input.companyId,
      chatId: input.chatId,
      threadRootId: input.threadRootId,
    });
    await larkChatContextService.clearMainMessages({
      companyId: input.companyId,
      chatId: input.chatId,
      upToMessageId: input.threadRootId,
    });
    await clearTaskState();
    return {
      responseText: '✓ Thread history and main conversation context cleared.',
    };
  }

  return {
    responseText: [
      'Available commands:',
      '`/clear` — clear this thread\'s history (keeps main chat context)',
      '`/clear --main` — clear thread + main chat context up to this thread',
    ].join('\n'),
  };
};
