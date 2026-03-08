import type { DesktopThread, DesktopMessage } from '../../generated/prisma';
import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class DesktopThreadsRepository extends BaseRepository {
  listThreads(userId: string, companyId: string): Promise<DesktopThread[]> {
    return prisma.desktopThread.findMany({
      where: { userId, companyId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  getThread(threadId: string, userId: string): Promise<DesktopThread | null> {
    return prisma.desktopThread.findFirst({
      where: { id: threadId, userId },
    });
  }

  createThread(userId: string, companyId: string): Promise<DesktopThread> {
    return prisma.desktopThread.create({
      data: { userId, companyId },
    });
  }

  updateThreadTitle(threadId: string, title: string): Promise<DesktopThread> {
    return prisma.desktopThread.update({
      where: { id: threadId },
      data: { title },
    });
  }

  touchThread(threadId: string): Promise<DesktopThread> {
    return prisma.desktopThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
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
