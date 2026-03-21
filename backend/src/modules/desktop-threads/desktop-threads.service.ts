import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { desktopThreadContextCache } from '../desktop-chat/desktop-thread-context.cache';
import { desktopThreadMetaCache } from '../desktop-chat/desktop-thread-meta.cache';
import { DesktopThreadsRepository, desktopThreadsRepository } from './desktop-threads.repository';
import { logger } from '../../utils/logger';

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
      summaryJson: thread.summaryJson && typeof thread.summaryJson === 'object' && !Array.isArray(thread.summaryJson)
        ? thread.summaryJson as Record<string, unknown>
        : null,
      summaryUpdatedAt: thread.summaryUpdatedAt?.toISOString?.() ?? null,
      taskStateJson: thread.taskStateJson && typeof thread.taskStateJson === 'object' && !Array.isArray(thread.taskStateJson)
        ? thread.taskStateJson as Record<string, unknown>
        : null,
      taskStateUpdatedAt: thread.taskStateUpdatedAt?.toISOString?.() ?? null,
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
    const meta = await desktopThreadMetaCache.getOrLoad({
      threadId,
      userId,
      loader: async () => {
        const thread = await this.repository.getThread(threadId, userId);
        if (!thread) throw new HttpException(404, 'Thread not found');
        return {
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
          summaryJson: thread.summaryJson && typeof thread.summaryJson === 'object' && !Array.isArray(thread.summaryJson)
            ? thread.summaryJson as Record<string, unknown>
            : null,
          summaryUpdatedAt: thread.summaryUpdatedAt?.toISOString?.() ?? null,
          taskStateJson: thread.taskStateJson && typeof thread.taskStateJson === 'object' && !Array.isArray(thread.taskStateJson)
            ? thread.taskStateJson as Record<string, unknown>
            : null,
          taskStateUpdatedAt: thread.taskStateUpdatedAt?.toISOString?.() ?? null,
          cachedAt: new Date().toISOString(),
        };
      },
    });
    return meta;
  }

  async getThreadContext(threadId: string, userId: string, limit = 120) {
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

  async getOwnedThreadContext(threadId: string, userId: string, limit = 120) {
    const thread = await this.repository.getOwnedThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');

    const messages = await this.repository.listMessages(threadId, limit);
    return { thread, messages };
  }

  async getOwnedThreadMessage(threadId: string, userId: string, messageId: string) {
    const message = await this.repository.getOwnedMessage(threadId, userId, messageId);
    if (!message) throw new HttpException(404, 'Message not found');
    return message;
  }

  async updateOwnedThreadMemory(
    threadId: string,
    userId: string,
    input: {
      summaryJson?: Record<string, unknown> | null;
      taskStateJson?: Record<string, unknown> | null;
    },
  ) {
    const thread = await this.repository.getOwnedThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');
    const updated = await this.repository.updateThreadMemory({
      threadId,
      ...input,
    });
    await this.cacheThreadMeta(updated);
    return updated;
  }

  async getCachedOwnedThreadContext(threadId: string, userId: string, limit = 120) {
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
      existingMessageId?: string;
    },
  ) {
    const thread = await this.repository.getOwnedThread(threadId, userId);
    if (!thread) throw new HttpException(404, 'Thread not found');
    if (options?.requiredChannel && thread.channel !== options.requiredChannel) {
      throw new HttpException(404, 'Thread not found');
    }

    const message = options?.existingMessageId
      ? await this.repository.updateMessage({
        messageId: options.existingMessageId,
        threadId,
        role,
        content,
        metadata,
      })
      : await this.repository.createMessage({ threadId, role, content, metadata });

    const contextLimit = options?.contextLimit ?? 40;
    void this.runPostCommitThreadMaintenance({
      thread,
      threadId,
      userId,
      role,
      content,
      contextLimit,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        metadata: message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
          ? message.metadata as Record<string, unknown>
          : undefined,
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
      contextLimit: 120,
    });
  }

  async deleteThread(threadId: string, userId: string): Promise<void> {
    await this.repository.deleteThread(threadId, userId);
    await desktopThreadMetaCache.invalidate(threadId, userId);
    await desktopThreadContextCache.invalidate(threadId, userId);
  }

  private async runPostCommitThreadMaintenance(input: {
    thread: Awaited<ReturnType<DesktopThreadsRepository['getOwnedThread']>>;
    threadId: string;
    userId: string;
    role: string;
    content: string;
    contextLimit: number;
    message: {
      id: string;
      role: string;
      content: string;
      metadata?: Record<string, unknown>;
    };
  }): Promise<void> {
    try {
      let latestThread = await this.repository.touchThread(input.threadId);

      if (!input.thread?.title && input.role === 'user' && input.thread?.channel === 'desktop') {
        const title = input.content.length > 60 ? input.content.slice(0, 57) + '...' : input.content;
        latestThread = await this.repository.updateThreadTitle(input.threadId, title);
      }

      await Promise.allSettled([
        this.cacheThreadMeta(latestThread),
        desktopThreadContextCache.appendMessage({
          threadId: input.threadId,
          userId: input.userId,
          maxMessages: input.contextLimit,
          message: input.message,
        }),
      ]);
    } catch (error) {
      logger.warn('desktop.thread.message.maintenance.failed', {
        threadId: input.threadId,
        userId: input.userId,
        messageId: input.message.id,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
    }
  }
}

export const desktopThreadsService = new DesktopThreadsService();
