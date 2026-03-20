import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { desktopThreadContextCache } from '../desktop-chat/desktop-thread-context.cache';
import { desktopThreadMetaCache } from '../desktop-chat/desktop-thread-meta.cache';
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

  private async cacheThreadMeta(thread: Awaited<ReturnType<DesktopThreadsRepository['getOwnedThread']>>) {
    if (!thread) return;
    await desktopThreadMetaCache.set({
      id: thread.id,
      userId: thread.userId,
      companyId: thread.companyId,
      title: thread.title ?? null,
      departmentId: thread.departmentId ?? null,
      department: thread.department
        ? {
          id: thread.department.id,
          name: thread.department.name,
          slug: thread.department.slug,
        }
        : null,
      lastMessageAt: thread.lastMessageAt?.toISOString?.() ?? null,
      cachedAt: new Date().toISOString(),
    });
  }

  private toCachedContext(
    threadId: string,
    userId: string,
    messages: Awaited<ReturnType<DesktopThreadsRepository['listMessages']>>,
  ) {
    return {
      threadId,
      userId,
      messages: messages.map((entry) => ({
        id: entry.id,
        role: entry.role,
        content: entry.content,
        metadata: entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
          ? entry.metadata as Record<string, unknown>
          : undefined,
      })),
      cachedAt: new Date().toISOString(),
    };
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

  async getThreadMeta(threadId: string, userId: string) {
    const thread = await this.repository.getThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');
    return thread;
  }

  async getThreadContext(threadId: string, userId: string, limit = 40) {
    const thread = await this.repository.getThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');

    const messages = await this.repository.listMessages(threadId, limit);
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

  async createThread(userId: string, companyId: string, departmentId?: string | null, title?: string | null) {
    const thread = await this.repository.createThread(userId, companyId, departmentId, title);
    await this.cacheThreadMeta(thread);
    return thread;
  }

  async findOrCreateNamedThread(
    userId: string,
    companyId: string,
    title: string,
    departmentId?: string | null,
  ) {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new HttpException(400, 'Thread title is required');
    }

    const existing = await this.repository.findThreadByTitle(userId, companyId, normalizedTitle);
    if (existing) {
      await this.cacheThreadMeta(existing);
      return existing;
    }

    const created = await this.repository.createThread(userId, companyId, departmentId, normalizedTitle);
    await this.cacheThreadMeta(created);
    return created;
  }

  async findOrCreateLarkLifetimeThread(
    userId: string,
    companyId: string,
    departmentId?: string | null,
  ) {
    const existing = await this.repository.findCanonicalLarkThread(userId, companyId);
    if (existing) {
      await this.cacheThreadMeta(existing);
      return existing;
    }

    const created = await this.repository.createLarkLifetimeThread(
      userId,
      companyId,
      departmentId,
      'Lark history',
    );
    await this.cacheThreadMeta(created);
    return created;
  }

  async getOwnedThreadContext(threadId: string, userId: string, limit = 40) {
    const thread = await this.repository.getOwnedThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');

    const messages = await this.repository.listMessages(threadId, limit);
    return { thread, messages };
  }

  async getCachedOwnedThreadContext(threadId: string, userId: string, limit = 40) {
    return desktopThreadContextCache.getOrLoad({
      threadId,
      userId,
      maxMessages: limit,
      loader: async () => {
        const context = await this.getOwnedThreadContext(threadId, userId, limit);
        return this.toCachedContext(threadId, userId, context.messages);
      },
    });
  }

  async addOwnedThreadMessage(
    threadId: string,
    userId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
    options?: {
      requiredChannel?: 'desktop' | 'lark';
      contextLimit?: number;
    },
  ) {
    const thread = await this.repository.getOwnedThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');
    if (options?.requiredChannel && thread.channel !== options.requiredChannel) {
      throw new HttpException(404, 'Thread not found');
    }

    const message = await this.repository.createMessage({ threadId, role, content, metadata });
    const touchedThread = await this.repository.touchThread(threadId);
    await this.cacheThreadMeta(touchedThread);

    if (!thread.title && role === 'user' && thread.channel === 'desktop') {
      const title = content.length > 60 ? content.slice(0, 57) + '...' : content;
      const updatedThread = await this.repository.updateThreadTitle(threadId, title);
      await this.cacheThreadMeta(updatedThread);
    }

    const contextLimit = options?.contextLimit ?? 40;
    await desktopThreadContextCache.appendMessage({
      threadId,
      userId,
      maxMessages: contextLimit,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        metadata: message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
          ? message.metadata as Record<string, unknown>
          : undefined,
      },
      loader: async () => {
        const context = await this.getOwnedThreadContext(threadId, userId, contextLimit);
        return this.toCachedContext(threadId, userId, context.messages);
      },
    });

    return message;
  }

  async addMessage(
    threadId: string,
    userId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.addOwnedThreadMessage(threadId, userId, role, content, metadata, {
      requiredChannel: 'desktop',
      contextLimit: 40,
    });
  }

  async deleteThread(threadId: string, userId: string): Promise<void> {
    await this.repository.deleteThread(threadId, userId);
    await desktopThreadMetaCache.invalidate(threadId, userId);
    await desktopThreadContextCache.invalidate(threadId, userId);
  }
}

export const desktopThreadsService = new DesktopThreadsService();
