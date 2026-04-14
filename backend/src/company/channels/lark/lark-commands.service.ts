import type { LarkChannelAdapter } from './lark.adapter';
import { larkChatContextService } from './lark-chat-context.service';
import { createEmptyTaskState } from '../../../modules/desktop-chat/desktop-thread-memory';
import { logger } from '../../../utils/logger';

export const handleLarkCommand = async (input: {
  commandText: string;
  chatId: string;
  chatType?: string;
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
      chatType: input.chatType,
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
      const result = await larkChatContextService.clearAllMessages({
        companyId: input.companyId,
        chatId: input.chatId,
      });
      await clearTaskState();
      logger.info('lark.chat_context.clear_completed', {
        companyId: input.companyId,
        chatId: input.chatId,
        chatType: input.chatType ?? 'unknown',
        mode: 'all',
        threadRootId: null,
        clearedRecentMessageCount: result.clearedRecentMessageCount,
        hadSummary: result.hadSummary,
        hadTaskState: result.hadTaskState,
      });
      return {
        responseText: [
          'All set.',
          'I cleared this chat\'s live conversation context and task state.',
          'I can start fresh from here.',
        ].join('\n'),
      };
    }

    if (!clearMain) {
      const result = await larkChatContextService.clearThreadMessages({
        companyId: input.companyId,
        chatId: input.chatId,
        threadRootId: input.threadRootId,
      });
      await clearTaskState();
      logger.info('lark.chat_context.clear_completed', {
        companyId: input.companyId,
        chatId: input.chatId,
        chatType: input.chatType ?? 'unknown',
        mode: 'thread_only',
        threadRootId: input.threadRootId,
        clearedRecentMessageCount: result.clearedRecentMessageCount,
        retainedRecentMessageCount: result.retainedRecentMessageCount,
        hadSummary: result.hadSummary,
        hadTaskState: result.hadTaskState,
      });
      return {
        responseText: [
          'All set.',
          'I cleared this thread\'s live context.',
          'The main chat context is still preserved.',
        ].join('\n'),
      };
    }

    const threadResult = await larkChatContextService.clearThreadMessages({
      companyId: input.companyId,
      chatId: input.chatId,
      threadRootId: input.threadRootId,
    });
    const mainResult = await larkChatContextService.clearMainMessages({
      companyId: input.companyId,
      chatId: input.chatId,
      upToMessageId: input.threadRootId,
    });
    await clearTaskState();
    logger.info('lark.chat_context.clear_completed', {
      companyId: input.companyId,
      chatId: input.chatId,
      chatType: input.chatType ?? 'unknown',
      mode: 'thread_and_main',
      threadRootId: input.threadRootId,
      clearedThreadRecentMessageCount: threadResult.clearedRecentMessageCount,
      clearedMainRecentMessageCount: mainResult.clearedRecentMessageCount,
      retainedRecentMessageCount: mainResult.retainedRecentMessageCount,
      hadSummary: threadResult.hadSummary || mainResult.hadSummary,
      hadTaskState: threadResult.hadTaskState || mainResult.hadTaskState,
    });
    return {
      responseText: [
        'All set.',
        'I cleared this thread and the related main-chat context for this conversation.',
        'I can continue from a clean slate.',
      ].join('\n'),
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
