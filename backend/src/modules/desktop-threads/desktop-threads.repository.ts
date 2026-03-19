import type { DesktopMessage } from '../../generated/prisma';
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

export class DesktopThreadsRepository extends BaseRepository {
  listThreads(userId: string, companyId: string) {
    return prisma.desktopThread.findMany({
      where: { userId, companyId },
      include: threadInclude,
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  getThread(threadId: string, userId: string) {
    return prisma.desktopThread.findFirst({
      where: { id: threadId, userId },
      include: threadInclude,
    });
  }

  findThreadByTitle(userId: string, companyId: string, title: string) {
    return prisma.desktopThread.findFirst({
      where: {
        userId,
        companyId,
        title,
      },
      include: threadInclude,
      orderBy: { updatedAt: 'desc' },
    });
  }

  createThread(userId: string, companyId: string, departmentId?: string | null, title?: string | null) {
    return prisma.desktopThread.create({
      data: {
        userId,
        companyId,
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

  async deleteThread(threadId: string, userId: string): Promise<void> {
    // Verify ownership before deleting
    const thread = await prisma.desktopThread.findFirst({ where: { id: threadId, userId } });
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

  countMessages(threadId: string): Promise<number> {
    return prisma.desktopMessage.count({ where: { threadId } });
  }
}

export const desktopThreadsRepository = new DesktopThreadsRepository();
