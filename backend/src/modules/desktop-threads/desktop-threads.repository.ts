import { Prisma, type DesktopMessage } from '../../generated/prisma';
import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export type DesktopMessagePageCursor = {
  id: string;
  createdAt: Date;
};

const threadInclude = {
  department: {
    select: {
      id: true,
      name: true,
      slug: true,
    },
  },
} as const;

const LARK_LIFETIME_THREAD_KEY = 'lifetime';

export class DesktopThreadsRepository extends BaseRepository {
  listThreads(userId: string, companyId: string) {
    return prisma.desktopThread.findMany({
      where: { userId, companyId, channel: 'desktop' },
      include: threadInclude,
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  getThread(threadId: string, userId: string) {
    return prisma.desktopThread.findFirst({
      where: { id: threadId, userId, channel: 'desktop' },
      include: threadInclude,
    });
  }

  getOwnedThread(threadId: string, userId: string) {
    return prisma.desktopThread.findFirst({
      where: { id: threadId, userId },
      include: threadInclude,
    });
  }

  getOwnedMessage(threadId: string, userId: string, messageId: string) {
    return prisma.desktopMessage.findFirst({
      where: {
        id: messageId,
        threadId,
        thread: {
          userId,
        },
      },
    });
  }

  findThreadByTitle(userId: string, companyId: string, title: string) {
    return prisma.desktopThread.findFirst({
      where: {
        userId,
        companyId,
        channel: 'desktop',
        title,
      },
      include: threadInclude,
      orderBy: { updatedAt: 'desc' },
    });
  }

  findCanonicalLarkThread(userId: string, companyId: string) {
    return prisma.desktopThread.findFirst({
      where: {
        userId,
        companyId,
        channel: 'lark',
        canonicalThreadKey: LARK_LIFETIME_THREAD_KEY,
      },
      include: threadInclude,
    });
  }

  createThread(userId: string, companyId: string, departmentId?: string | null, title?: string | null) {
    return prisma.desktopThread.create({
      data: {
        userId,
        companyId,
        channel: 'desktop',
        departmentId: departmentId ?? null,
        ...(title ? { title } : {}),
      },
      include: threadInclude,
    });
  }

  createLarkLifetimeThread(userId: string, companyId: string, departmentId?: string | null, title?: string | null) {
    return prisma.desktopThread.create({
      data: {
        userId,
        companyId,
        channel: 'lark',
        canonicalThreadKey: LARK_LIFETIME_THREAD_KEY,
        departmentId: departmentId ?? null,
        ...(title ? { title } : {}),
      },
      include: threadInclude,
    });
  }

  updateThreadTitle(threadId: string, title: string) {
    return prisma.desktopThread.update({
      where: { id: threadId },
      data: { title },
      include: threadInclude,
    });
  }

  touchThread(threadId: string) {
    return prisma.desktopThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
      include: threadInclude,
    });
  }

  updateThreadMemory(input: {
    threadId: string;
    summaryJson?: Record<string, unknown> | null;
    taskStateJson?: Record<string, unknown> | null;
  }) {
    return prisma.desktopThread.update({
      where: { id: input.threadId },
      data: {
        ...(input.summaryJson !== undefined
          ? {
            summaryJson: input.summaryJson ? JSON.parse(JSON.stringify(input.summaryJson)) : Prisma.DbNull,
            summaryUpdatedAt: input.summaryJson ? new Date() : null,
          }
          : {}),
        ...(input.taskStateJson !== undefined
          ? {
            taskStateJson: input.taskStateJson ? JSON.parse(JSON.stringify(input.taskStateJson)) : Prisma.DbNull,
            taskStateUpdatedAt: input.taskStateJson ? new Date() : null,
          }
          : {}),
      },
      include: threadInclude,
    });
  }

  async deleteThread(threadId: string, userId: string): Promise<void> {
    // Verify ownership before deleting
    const thread = await prisma.desktopThread.findFirst({ where: { id: threadId, userId, channel: 'desktop' } });
    if (!thread) return;
    await prisma.desktopMessage.deleteMany({ where: { threadId } });
    await prisma.desktopThread.delete({ where: { id: threadId } });
  }

  listMessages(threadId: string, limit = 100): Promise<DesktopMessage[]> {
    return prisma.desktopMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  getMessageCursor(threadId: string, messageId: string): Promise<DesktopMessagePageCursor | null> {
    return prisma.desktopMessage.findFirst({
      where: { id: messageId, threadId },
      select: {
        id: true,
        createdAt: true,
      },
    });
  }

  async listMessagesPage(
    threadId: string,
    input: {
      limit: number;
      before?: DesktopMessagePageCursor | null;
    },
  ): Promise<{ messages: DesktopMessage[]; hasMoreOlder: boolean }> {
    const rows = await prisma.desktopMessage.findMany({
      where: input.before
        ? {
          threadId,
          OR: [
            { createdAt: { lt: input.before.createdAt } },
            {
              AND: [
                { createdAt: input.before.createdAt },
                { id: { lt: input.before.id } },
              ],
            },
          ],
        }
        : { threadId },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: input.limit + 1,
    });

    const hasMoreOlder = rows.length > input.limit;
    const pageRows = hasMoreOlder ? rows.slice(0, input.limit) : rows;

    return {
      messages: pageRows.reverse(),
      hasMoreOlder,
    };
  }

  createMessage(data: {
    threadId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<DesktopMessage> {
    return prisma.desktopMessage.create({
      data: {
        threadId: data.threadId,
        role: data.role,
        content: data.content,
        metadata: data.metadata ? JSON.parse(JSON.stringify(data.metadata)) : undefined,
      },
    });
  }

  updateMessage(data: {
    messageId: string;
    threadId: string;
    role?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DesktopMessage> {
    return prisma.desktopMessage.update({
      where: { id: data.messageId },
      data: {
        ...(data.role ? { role: data.role } : {}),
        ...(data.content !== undefined ? { content: data.content } : {}),
        ...(data.metadata !== undefined
          ? { metadata: JSON.parse(JSON.stringify(data.metadata)) }
          : {}),
      },
    });
  }

  countMessages(threadId: string): Promise<number> {
    return prisma.desktopMessage.count({ where: { threadId } });
  }
}

export const desktopThreadsRepository = new DesktopThreadsRepository();
