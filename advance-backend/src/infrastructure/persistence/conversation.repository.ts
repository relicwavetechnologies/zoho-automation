import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { Turn } from '../../domain/conversation/turn';

export interface ConversationRepoPort {
  getHistory(chatId: string, limit?: number): Promise<Result<Turn[], InfraError>>;
  appendTurn(chatId: string, turn: Omit<Turn, 'id'>, meta?: { companyId?: string; channel?: string }): Promise<Result<Turn, InfraError>>;
  clearHistory(chatId: string): Promise<Result<void, InfraError>>;
}

export class ConversationRepository implements ConversationRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async getHistory(chatId: string, limit = 40): Promise<Result<Turn[], InfraError>> {
    try {
      const conv = await this.db.runtimeConversation.findFirst({
        where: { channelConversationKey: chatId },
        include: {
          messages: {
            orderBy: { sequence: 'asc' },
            take: limit,
          },
        },
      });
      if (!conv) return ok([]);
      const turns: Turn[] = conv.messages.map(r => {
        const base: Turn = {
          id: r.id,
          role: r.role as Turn['role'],
          content: r.contentText ?? (r.contentJson !== null ? JSON.stringify(r.contentJson) : ''),
          timestamp: r.createdAt.toISOString(),
        };
        if (r.toolCallJson !== null) {
          const toolName = (r.toolCallJson as Record<string, unknown>)['name'];
          if (typeof toolName === 'string') (base as unknown as Record<string, unknown>)['toolName'] = toolName;
        }
        if (r.toolResultJson !== null) {
          (base as unknown as Record<string, unknown>)['toolOutcome'] = r.toolResultJson;
        }
        return base;
      });
      return ok(turns);
    } catch (e) {
      return err(wrapInfra('prisma', 'getConversationHistory', e));
    }
  }

  async appendTurn(
    chatId: string,
    turn: Omit<Turn, 'id'>,
    meta?: { companyId?: string; channel?: string },
  ): Promise<Result<Turn, InfraError>> {
    try {
      const companyId = meta?.companyId ?? 'system';
      const channel = meta?.channel ?? 'lark';

      // Find or create the conversation
      let conv = await this.db.runtimeConversation.findFirst({
        where: { channelConversationKey: chatId },
      });

      if (!conv) {
        conv = await this.db.runtimeConversation.create({
          data: {
            companyId,
            channel,
            channelConversationKey: chatId,
            rawChannelKey: chatId,
          },
        });
      }

      const sequence = conv.lastMessageSequence + 1;

      const row = await this.db.runtimeConversationMessage.create({
        data: {
          conversationId: conv.id,
          sequence,
          role: turn.role,
          messageKind: turn.role === 'tool' ? 'tool_result' : 'text',
          sourceChannel: channel,
          contentText: turn.content,
          ...(turn.toolName !== undefined ? { toolCallJson: { name: turn.toolName } } : {}),
          ...(turn.toolOutcome !== undefined ? { toolResultJson: turn.toolOutcome as object } : {}),
        },
      });

      await this.db.runtimeConversation.update({
        where: { id: conv.id },
        data: { lastMessageSequence: sequence },
      });

      const appended: Turn = {
        id: row.id,
        role: row.role as Turn['role'],
        content: row.contentText ?? '',
        timestamp: row.createdAt.toISOString(),
      };
      if (row.toolCallJson !== null) {
        const n = (row.toolCallJson as Record<string, unknown>)['name'];
        if (typeof n === 'string') (appended as unknown as Record<string, unknown>)['toolName'] = n;
      }
      if (row.toolResultJson !== null) (appended as unknown as Record<string, unknown>)['toolOutcome'] = row.toolResultJson;
      return ok(appended);
    } catch (e) {
      return err(wrapInfra('prisma', 'appendConversationTurn', e));
    }
  }

  async clearHistory(chatId: string): Promise<Result<void, InfraError>> {
    try {
      const conv = await this.db.runtimeConversation.findFirst({
        where: { channelConversationKey: chatId },
      });
      if (conv) {
        await this.db.runtimeConversationMessage.deleteMany({ where: { conversationId: conv.id } });
      }
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'clearConversationHistory', e));
    }
  }
}
