import type { PrismaClient } from '../../generated/prisma';

export interface TodoItem {
  id:       string;
  title:    string;
  status:   string;
  position: number;
}

export interface CreateTodoInput {
  companyId: string;
  userId:    string;
  channel:   string;
  chatId:    string;
  threadId?: string;
  title:     string;
  position:  number;
}

export interface UpdateTodoInput {
  id:     string;
  status: string;
}

export class SupervisorTodoRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByChatId(chatId: string, userId: string): Promise<TodoItem[]> {
    const now = new Date();
    const rows = await this.prisma.supervisorTodo.findMany({
      where: { chatId, userId, expiresAt: { gt: now } },
      orderBy: { position: 'asc' },
      select: { id: true, title: true, status: true, position: true },
    });
    return rows;
  }

  async create(input: CreateTodoInput): Promise<TodoItem> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h TTL
    const row = await this.prisma.supervisorTodo.create({
      data: {
        companyId: input.companyId,
        userId:    input.userId,
        channel:   input.channel,
        chatId:    input.chatId,
        title:     input.title,
        position:  input.position,
        status:    'pending',
        expiresAt,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      select: { id: true, title: true, status: true, position: true },
    });
    return row;
  }

  async updateStatus(input: UpdateTodoInput): Promise<TodoItem | null> {
    try {
      const row = await this.prisma.supervisorTodo.update({
        where: { id: input.id },
        data:  { status: input.status },
        select: { id: true, title: true, status: true, position: true },
      });
      return row;
    } catch {
      return null; // todo not found — non-fatal
    }
  }

  async clearByChatId(chatId: string, userId: string): Promise<void> {
    await this.prisma.supervisorTodo.deleteMany({ where: { chatId, userId } });
  }

  async expireOld(): Promise<void> {
    await this.prisma.supervisorTodo.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }
}
