import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export interface LarkChatContextRow {
  id: string;
  companyId: string;
  chatId: string;
  chatType: string | null;
  recentMessagesJson: unknown;
  summaryJson: unknown;
  sourceMessageCount: number;
  lastMessageAt: Date | null;
}

export interface LarkChatContextRepoPort {
  getOrCreate(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
  }): Promise<Result<LarkChatContextRow, InfraError>>;

  update(
    id: string,
    data: {
      recentMessagesJson: unknown;
      summaryJson?: unknown;
      sourceMessageCount: number;
      lastMessageAt: Date;
    },
  ): Promise<Result<void, InfraError>>;

  clear(companyId: string, chatId: string): Promise<Result<void, InfraError>>;
}

export class LarkChatContextRepository implements LarkChatContextRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async getOrCreate(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
  }): Promise<Result<LarkChatContextRow, InfraError>> {
    try {
      const row = await this.db.larkChatContext.upsert({
        where: {
          companyId_channel_chatId: {
            companyId: input.companyId,
            channel: 'lark',
            chatId: input.chatId,
          },
        },
        create: {
          companyId: input.companyId,
          chatId: input.chatId,
          channel: 'lark',
          chatType: input.chatType ?? null,
          recentMessagesJson: [],
          sourceMessageCount: 0,
        },
        update: {},
      });
      return ok({
        id: row.id,
        companyId: row.companyId,
        chatId: row.chatId,
        chatType: row.chatType,
        recentMessagesJson: row.recentMessagesJson,
        summaryJson: row.summaryJson,
        sourceMessageCount: row.sourceMessageCount,
        lastMessageAt: row.lastMessageAt,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'larkChatContext.getOrCreate', e));
    }
  }

  async update(
    id: string,
    data: {
      recentMessagesJson: unknown;
      summaryJson?: unknown;
      sourceMessageCount: number;
      lastMessageAt: Date;
    },
  ): Promise<Result<void, InfraError>> {
    try {
      await this.db.larkChatContext.update({
        where: { id },
        data: {
          recentMessagesJson: data.recentMessagesJson as any,
          ...(data.summaryJson !== undefined
            ? { summaryJson: data.summaryJson as any, summaryUpdatedAt: new Date() }
            : {}),
          sourceMessageCount: data.sourceMessageCount,
          lastMessageAt: data.lastMessageAt,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'larkChatContext.update', e));
    }
  }

  async clear(companyId: string, chatId: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.larkChatContext.updateMany({
        where: { companyId, channel: 'lark', chatId },
        data: {
          recentMessagesJson: Prisma.JsonNull,
          summaryJson: Prisma.JsonNull,
          sourceMessageCount: 0,
          summaryUpdatedAt: Prisma.DbNull as any,
          lastMessageAt: Prisma.DbNull as any,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'larkChatContext.clear', e));
    }
  }
}
