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
  updatedAt: Date;
}

export interface LarkChatContextRepoPort {
  getOrCreate(input: {
    companyId: string;
    chatId: string;
    chatType?: string;
  }): Promise<Result<LarkChatContextRow, InfraError>>;


  /**
   * The room as stored, or `null` when it has none. Creates nothing.
   *
   * Read paths must use this rather than `getOrCreate`: that one upserts, so
   * reading through it would leave an empty row behind for every room Divo
   * merely observed and refresh `updatedAt` on rooms nobody wrote to.
   */
  get(input: {
    companyId: string;
    chatId: string;
  }): Promise<Result<LarkChatContextRow | null, InfraError>>;

  /**
   * Every company that has seen this chat. Normally one, and normally the
   * caller's own — a second entry means one Lark installation is serving more
   * than one Divo company and the same room is reachable from both.
   */
  listCompanyIdsForChat(
    chatId: string,
  ): Promise<Result<readonly string[], InfraError>>;

  update(
    id: string,
    expectedUpdatedAt: Date,
    data: {
      recentMessagesJson: unknown;
      summaryJson?: unknown;
      sourceMessageCount: number;
      lastMessageAt: Date;
    },
  ): Promise<Result<boolean, InfraError>>;

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
        updatedAt: row.updatedAt,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'larkChatContext.getOrCreate', e));
    }
  }

  async get(input: {
    companyId: string;
    chatId: string;
  }): Promise<Result<LarkChatContextRow | null, InfraError>> {
    try {
      const row = await this.db.larkChatContext.findUnique({
        where: {
          companyId_channel_chatId: {
            companyId: input.companyId,
            channel: 'lark',
            chatId: input.chatId,
          },
        },
      });
      if (!row) return ok(null);
      return ok({
        id: row.id,
        companyId: row.companyId,
        chatId: row.chatId,
        chatType: row.chatType,
        recentMessagesJson: row.recentMessagesJson,
        summaryJson: row.summaryJson,
        sourceMessageCount: row.sourceMessageCount,
        lastMessageAt: row.lastMessageAt,
        updatedAt: row.updatedAt,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'larkChatContext.get', e));
    }
  }

  async listCompanyIdsForChat(
    chatId: string,
  ): Promise<Result<readonly string[], InfraError>> {
    try {
      const rows = await this.db.larkChatContext.findMany({
        where: { channel: 'lark', chatId },
        select: { companyId: true },
        distinct: ['companyId'],
      });
      return ok(rows.map(row => row.companyId));
    } catch (e) {
      return err(wrapInfra('prisma', 'larkChatContext.listCompanyIdsForChat', e));
    }
  }


  async update(
    id: string,
    expectedUpdatedAt: Date,
    data: {
      recentMessagesJson: unknown;
      summaryJson?: unknown;
      sourceMessageCount: number;
      lastMessageAt: Date;
    },
  ): Promise<Result<boolean, InfraError>> {
    try {
      const updated = await this.db.larkChatContext.updateMany({
        where: { id, updatedAt: expectedUpdatedAt },
        data: {
          recentMessagesJson: data.recentMessagesJson as any,
          ...(data.summaryJson !== undefined
            ? { summaryJson: data.summaryJson as any, summaryUpdatedAt: new Date() }
            : {}),
          sourceMessageCount: data.sourceMessageCount,
          lastMessageAt: data.lastMessageAt,
        },
      });
      return ok(updated.count === 1);
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
          summaryUpdatedAt: null,
          lastMessageAt: null,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'larkChatContext.clear', e));
    }
  }
}
