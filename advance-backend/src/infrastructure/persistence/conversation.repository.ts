import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { Turn } from '../../domain/conversation/turn';
import type { CachePort } from '../../shared/cache';

const HISTORY_CACHE_TTL = 300; // 5 min; invalidated on every appendTurn
const historyCacheKey = (chatId: string) => `history:v1:${chatId}`;

export interface ConversationRepoPort {
  getHistory(chatId: string, limit?: number): Promise<Result<Turn[], InfraError>>;
  appendTurn(chatId: string, turn: Omit<Turn, 'id'>, meta?: { companyId?: string; channel?: string }): Promise<Result<Turn, InfraError>>;
  clearHistory(chatId: string): Promise<Result<void, InfraError>>;
}

export class ConversationRepository implements ConversationRepoPort {
  constructor(
    private readonly db: PrismaClient,
    private readonly cache?: CachePort,
  ) {}

  async getHistory(chatId: string, limit = 40): Promise<Result<Turn[], InfraError>> {
    // Cache read — cache stores the full window; apply limit in memory.
    if (this.cache) {
      const cached = await this.cache.get<Turn[]>(historyCacheKey(chatId));
      if (cached.ok && cached.value !== null) {
        return ok(cached.value.slice(0, limit));
      }
    }

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
      // Populate cache — fire-and-forget; don't block the caller.
      if (this.cache && turns.length > 0) {
        void this.cache.set(historyCacheKey(chatId), turns, HISTORY_CACHE_TTL);
      }
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
        try {
          conv = await this.db.runtimeConversation.create({
            data: {
              companyId,
              channel,
              channelConversationKey: chatId,
              rawChannelKey: chatId,
            },
          });
        } catch {
          // Race: another concurrent request created the conversation first — re-fetch.
          const refetched = await this.db.runtimeConversation.findFirst({
            where: { channelConversationKey: chatId },
          });
          if (!refetched) throw new Error(`conversation_repo: failed to find or create conv for chatId=${chatId}`);
          conv = refetched;
        }
      }

      // Atomically claim the next sequence number. This single UPDATE is the only
      // writer of lastMessageSequence, so concurrent calls always get distinct values
      // and the unique constraint on (conversationId, sequence) can never be violated.
      const claimed = await this.db.runtimeConversation.update({
        where: { id: conv.id },
        data:  { lastMessageSequence: { increment: 1 } },
        select: { lastMessageSequence: true },
      });
      const sequence = claimed.lastMessageSequence;

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
      // No separate lastMessageSequence update needed — already incremented above.

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
      // Invalidate history cache so next getHistory() fetches fresh turns.
      if (this.cache) {
        void this.cache.del(historyCacheKey(chatId));
      }
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
      if (this.cache) {
        void this.cache.del(historyCacheKey(chatId));
      }
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'clearConversationHistory', e));
    }
  }
}
