import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { DesktopThreadsRepository, desktopThreadsRepository } from './desktop-threads.repository';

export type DesktopThreadMessagesPage = {
  thread: Awaited<ReturnType<DesktopThreadsRepository['getThread']>>;
  messages: Awaited<ReturnType<DesktopThreadsRepository['listMessages']>>;
  pagination: {
    hasMoreOlder: boolean;
    nextBeforeMessageId: string | null;
    limit: number;
  };
};

export class DesktopThreadsService extends BaseService {
  constructor(private readonly repository: DesktopThreadsRepository = desktopThreadsRepository) {
    super();
  }

  async listThreads(userId: string, companyId: string) {
    return this.repository.listThreads(userId, companyId);
  }

  async getThread(threadId: string, userId: string) {
    const thread = await this.repository.getThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');

    const messages = await this.repository.listMessages(threadId);
    return { thread, messages };
  }

  async getThreadMessagesPage(
    threadId: string,
    userId: string,
    input: {
      limit: number;
      beforeMessageId?: string;
    },
  ): Promise<DesktopThreadMessagesPage> {
    const thread = await this.repository.getThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');

    const before = input.beforeMessageId
      ? await this.repository.getMessageCursor(threadId, input.beforeMessageId)
      : null;

    if (input.beforeMessageId && !before) {
      throw new HttpException(404, 'Message cursor not found');
    }

    const page = await this.repository.listMessagesPage(threadId, {
      limit: input.limit,
      before,
    });

    return {
      thread,
      messages: page.messages,
      pagination: {
        hasMoreOlder: page.hasMoreOlder,
        nextBeforeMessageId: page.hasMoreOlder && page.messages.length > 0 ? page.messages[0].id : null,
        limit: input.limit,
      },
    };
  }

  async createThread(userId: string, companyId: string) {
    return this.repository.createThread(userId, companyId);
  }

  async addMessage(
    threadId: string,
    userId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    // Verify ownership
    const thread = await this.repository.getThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');

    const message = await this.repository.createMessage({ threadId, role, content, metadata });
    await this.repository.touchThread(threadId);

    // Auto-title from first user message
    if (!thread.title && role === 'user') {
      const title = content.length > 60 ? content.slice(0, 57) + '...' : content;
      await this.repository.updateThreadTitle(threadId, title);
    }

    return message;
  }

  async deleteThread(threadId: string, userId: string): Promise<void> {
    await this.repository.deleteThread(threadId, userId);
  }
}

export const desktopThreadsService = new DesktopThreadsService();
