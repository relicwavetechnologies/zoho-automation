import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { Turn } from '../../domain/conversation/turn';
import type { CachePort } from '../../shared/cache';
import type { ConversationScope } from '../../domain/conversation/conversation-scope';
import { conversationCacheKey, conversationUniqueKey } from '../../domain/conversation/conversation-scope';
import {
  SHOPIFY_ERASURE_LOCK_NAMESPACE,
  shopifyErasureLockKey,
  shopifyErasureSourceId,
} from '../../application/shopify/shopify-erasure-fence';

const HISTORY_CACHE_TTL = 300; // 5 min; invalidated on every appendTurn
const HISTORY_CACHE_WINDOW = 60;

interface CachedConversationHistory {
  readonly revision: number;
  readonly turns: Turn[];
}

function latestTurns(turns: readonly Turn[], limit: number): Turn[] {
  return turns.slice(Math.max(0, turns.length - limit));
}

export interface ConversationMeta {
  id: string;
  summaryJson: unknown;
  lastSummarizedSequence: number;
  lastMessageSequence: number;
}

export interface ConversationRepoPort {
  getHistory(chatId: string, limit?: number, scope?: ConversationScope): Promise<Result<Turn[], InfraError>>;
  appendTurn(
    chatId: string,
    turn: Omit<Turn, 'id'>,
    scope?: ConversationScope,
    metadata?: ConversationTurnMetadata,
  ): Promise<Result<Turn, InfraError>>;
  /** Clear one exact DM, thread, or inline-requester conversation. */
  clearHistory(chatId: string, scope: ConversationScope): Promise<Result<boolean, InfraError>>;
  /**
   * Clear every conversation belonging to a chat, including thread-scoped and
   * inline-requester conversations underneath it.
   */
  clearChatHistories(chatId: string, scope: ConversationScope): Promise<Result<number, InfraError>>;
  getConversationMeta(chatId: string, scope?: ConversationScope): Promise<Result<ConversationMeta | null, InfraError>>;
  updateSummary(conversationId: string, data: {
    summaryJson: unknown;
    summaryUpdatedAt: Date;
    lastSummarizedSequence: number;
  }): Promise<Result<void, InfraError>>;
  getHistoryAfterSequence(chatId: string, afterSequence: number, limit?: number, scope?: ConversationScope): Promise<Result<Turn[], InfraError>>;
}

export interface ConversationTurnMetadata {
  /** Stable channel/run key. Re-delivery returns the existing turn. */
  readonly dedupeKey?: string;
  readonly sourceMessageId?: string;
  /** Backend-issued Pi run ID used only for exact provider-erasure correlation. */
  readonly sourceRunId?: string;
}

/**
 * Escape LIKE metacharacters so a prefix match means what it reads as.
 *
 * Prisma compiles `startsWith` to LIKE and does not escape the pattern, so `%`
 * and `_` in caller-supplied text stay wildcards. Backslash first, or it would
 * escape the escapes added after it.
 */
const escapeLikePrefix = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

async function findOrCreateUnscopedConversation(
  store: Pick<PrismaClient, 'runtimeConversation'>,
  chatId: string,
  companyId: string,
  channel: string,
) {
  const existing = await store.runtimeConversation.findFirst({
    where: { channelConversationKey: chatId },
  });
  if (existing) return existing;
  try {
    return await store.runtimeConversation.create({
      data: {
        companyId,
        channel,
        channelConversationKey: chatId,
        rawChannelKey: chatId,
      },
    });
  } catch (cause) {
    const raced = await store.runtimeConversation.findFirst({
      where: { channelConversationKey: chatId },
    });
    if (raced) return raced;
    throw cause;
  }
}

export class ConversationRepository implements ConversationRepoPort {
  constructor(
    private readonly db: PrismaClient,
    private readonly cache?: CachePort,
  ) {}

  async getHistory(chatId: string, limit = 40, scope?: ConversationScope): Promise<Result<Turn[], InfraError>> {
    const cacheKey = conversationCacheKey(chatId, scope);
    // A cache hit is accepted only after checking the durable generation. A
    // privacy erasure increments it in the same PostgreSQL transaction as the
    // deletes, so an old Redis value cannot be served after commit.
    if (this.cache) {
      const cached = await this.cache.get<CachedConversationHistory | Turn[]>(cacheKey);
      if (cached.ok && cached.value !== null) {
        const current = scope
          ? await this.db.runtimeConversation.findUnique({
            where: { companyId_channel_channelConversationKey: conversationUniqueKey(chatId, scope) },
            select: { historyRevision: true },
          })
          : await this.db.runtimeConversation.findFirst({
            where: { channelConversationKey: chatId },
            select: { historyRevision: true },
          });
        if (!current) return ok([]);
        const cachedRevision = Array.isArray(cached.value) ? 0 : cached.value.revision;
        const cachedTurns = Array.isArray(cached.value) ? cached.value : cached.value.turns;
        const currentRevision = Number.isInteger(current.historyRevision)
          ? current.historyRevision
          : 0;
        if (cachedRevision === currentRevision) {
          return ok(latestTurns(cachedTurns, limit));
        }
      }
    }

    try {
      const dbLimit = Math.max(limit, HISTORY_CACHE_WINDOW);
      const conv = scope
        ? await this.db.runtimeConversation.findUnique({
          where: { companyId_channel_channelConversationKey: conversationUniqueKey(chatId, scope) },
          include: { messages: { orderBy: { sequence: 'desc' }, take: dbLimit } },
        })
        : await this.db.runtimeConversation.findFirst({
          where: { channelConversationKey: chatId },
          include: { messages: { orderBy: { sequence: 'desc' }, take: dbLimit } },
        });
      if (!conv) return ok([]);
      const messages = [...conv.messages].reverse();
      const turns: Turn[] = messages.map(r => {
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
        void this.cache.set(cacheKey, {
          revision: conv.historyRevision,
          turns,
        } satisfies CachedConversationHistory, HISTORY_CACHE_TTL);
      }
      return ok(latestTurns(turns, limit));
    } catch (e) {
      return err(wrapInfra('prisma', 'getConversationHistory', e));
    }
  }

  async appendTurn(
    chatId: string,
    turn: Omit<Turn, 'id'>,
    scope?: ConversationScope,
    metadata?: ConversationTurnMetadata,
  ): Promise<Result<Turn, InfraError>> {
    try {
      const companyId = scope?.companyId ?? 'system';
      const channel = scope?.channel ?? 'lark';
      const cacheKey = conversationCacheKey(chatId, scope);
      const persist = async (store: Pick<
        PrismaClient,
        'runtimeConversation' | 'runtimeConversationMessage'
      >) => {
        const conv = scope
          ? await store.runtimeConversation.upsert({
            where: { companyId_channel_channelConversationKey: conversationUniqueKey(chatId, scope) },
            create: {
              companyId,
              channel,
              channelConversationKey: chatId,
              rawChannelKey: chatId,
            },
            update: {},
          })
          : await findOrCreateUnscopedConversation(store, chatId, companyId, channel);

        if (metadata?.dedupeKey) {
          const existing = await store.runtimeConversationMessage.findUnique({
            where: {
              conversationId_dedupeKey: {
                conversationId: conv.id,
                dedupeKey: metadata.dedupeKey,
              },
            },
          });
          if (existing) return existing;
        }

        // The conversation-row update serializes sequence allocation. For a
        // provider-correlated turn it shares the erasure transaction's source
        // advisory lock, so append-first is swept and erase-first is rejected.
        const claimed = await store.runtimeConversation.update({
          where: { id: conv.id },
          data: {
            lastMessageSequence: { increment: 1 },
            historyRevision: { increment: 1 },
          },
          select: { lastMessageSequence: true },
        });
        const data = {
          conversationId: conv.id,
          sequence: claimed.lastMessageSequence,
          role: turn.role,
          messageKind: turn.role === 'tool' ? 'tool_result' : 'text',
          sourceChannel: channel,
          contentText: turn.content,
          ...(metadata?.dedupeKey ? { dedupeKey: metadata.dedupeKey } : {}),
          ...(metadata?.sourceMessageId ? { sourceMessageId: metadata.sourceMessageId } : {}),
          ...(metadata?.sourceRunId ? { sourceRunId: metadata.sourceRunId } : {}),
          ...(turn.toolName !== undefined ? { toolCallJson: { name: turn.toolName } } : {}),
          ...(turn.toolOutcome !== undefined ? { toolResultJson: turn.toolOutcome as object } : {}),
        };
        if (!metadata?.dedupeKey) {
          return store.runtimeConversationMessage.create({ data });
        }
        return store.runtimeConversationMessage.upsert({
          where: {
            conversationId_dedupeKey: {
              conversationId: conv.id,
              dedupeKey: metadata.dedupeKey,
            },
          },
          create: data,
          update: {},
        });
      };

      const row = scope && metadata?.sourceRunId
        ? await this.db.$transaction(async tx => {
          const sourceId = shopifyErasureSourceId(channel, metadata.sourceRunId!);
          const lockKey = shopifyErasureLockKey(companyId, sourceId);
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${SHOPIFY_ERASURE_LOCK_NAMESPACE}),
              hashtext(${lockKey})
            )::text AS lock_result
          `;
          const erased = await tx.shopifyRunErasureFence.findUnique({
            where: { companyId_sourceId: { companyId, sourceId } },
            select: { id: true },
          });
          if (erased) throw new Error('Provider-derived conversation turn was erased before persistence.');
          return persist(tx);
        })
        : await persist(this.db);

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
        void this.cache.del(cacheKey);
      }
      return ok(appended);
    } catch (e) {
      return err(wrapInfra('prisma', 'appendConversationTurn', e));
    }
  }

  async clearHistory(
    chatId: string,
    scope: ConversationScope,
  ): Promise<Result<boolean, InfraError>> {
    try {
      const conversation = await this.db.runtimeConversation.findUnique({
        where: { companyId_channel_channelConversationKey: conversationUniqueKey(chatId, scope) },
        select: { id: true },
      });
      if (conversation) {
        await this.db.runtimeConversationMessage.deleteMany({
          where: { conversationId: conversation.id },
        });
        await this.db.runtimeConversation.update({
          where: { id: conversation.id },
          data: {
            summaryJson: Prisma.JsonNull,
            summaryUpdatedAt: null,
            lastSummarizedSequence: 0,
            historyRevision: { increment: 1 },
          },
        });
      }
      if (this.cache) {
        void this.cache.del(conversationCacheKey(chatId, scope));
      }
      return ok(Boolean(conversation));
    } catch (e) {
      return err(wrapInfra('prisma', 'clearHistory', e));
    }
  }

  async clearChatHistories(
    chatId: string,
    scope: ConversationScope,
  ): Promise<Result<number, InfraError>> {
    try {
      const conversations = await this.db.runtimeConversation.findMany({
        where: {
          companyId: scope.companyId,
          channel: scope.channel,
          OR: [
            { channelConversationKey: chatId },
            // Thread keys are `<chatId>:thread:<threadIdentity>`. The separator
            // is part of the prefix so a different chat whose ID merely starts
            // with this one cannot be swept up. The chat ID is escaped because
            // `startsWith` compiles to LIKE without escaping, and this is a
            // delete path whose match set comes from an event payload: a `%`
            // in a chat ID would otherwise let one member's `/clear` match
            // every conversation in their company.
            { channelConversationKey: { startsWith: `${escapeLikePrefix(chatId)}:thread:` } },
            { channelConversationKey: { startsWith: `${escapeLikePrefix(chatId)}:user:` } },
          ],
        },
        select: { id: true, channelConversationKey: true },
      });

      if (conversations.length > 0) {
        await this.db.runtimeConversationMessage.deleteMany({
          where: { conversationId: { in: conversations.map(c => c.id) } },
        });
        await this.db.runtimeConversation.updateMany({
          where: { id: { in: conversations.map(c => c.id) } },
          data: {
            summaryJson: Prisma.JsonNull,
            summaryUpdatedAt: null,
            lastSummarizedSequence: 0,
            historyRevision: { increment: 1 },
          },
        });
      }

      if (this.cache) {
        for (const conv of conversations) {
          void this.cache.del(conversationCacheKey(conv.channelConversationKey, scope));
        }
        // The chat key itself may have no row yet still hold a cached window.
        void this.cache.del(conversationCacheKey(chatId, scope));
      }

      return ok(conversations.length);
    } catch (e) {
      return err(wrapInfra('prisma', 'clearChatHistories', e));
    }
  }

  async getConversationMeta(chatId: string, scope?: ConversationScope): Promise<Result<ConversationMeta | null, InfraError>> {
    try {
      const select = {
        id: true,
        summaryJson: true,
        lastSummarizedSequence: true,
        lastMessageSequence: true,
      } as const;
      const conv = scope
        ? await this.db.runtimeConversation.findUnique({
          where: { companyId_channel_channelConversationKey: conversationUniqueKey(chatId, scope) },
          select,
        })
        : await this.db.runtimeConversation.findFirst({ where: { channelConversationKey: chatId }, select });
      if (!conv) return ok(null);
      return ok({
        id: conv.id,
        summaryJson: conv.summaryJson,
        lastSummarizedSequence: conv.lastSummarizedSequence,
        lastMessageSequence: conv.lastMessageSequence,
      });
    } catch (e) {
      return err(wrapInfra('prisma', 'getConversationMeta', e));
    }
  }

  async updateSummary(
    conversationId: string,
    data: { summaryJson: unknown; summaryUpdatedAt: Date; lastSummarizedSequence: number },
  ): Promise<Result<void, InfraError>> {
    try {
      await this.db.runtimeConversation.update({
        where: { id: conversationId },
        data: {
          summaryJson: data.summaryJson as object,
          summaryUpdatedAt: data.summaryUpdatedAt,
          lastSummarizedSequence: data.lastSummarizedSequence,
        },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'updateConversationSummary', e));
    }
  }

  async getHistoryAfterSequence(
    chatId: string,
    afterSequence: number,
    limit = 60,
    scope?: ConversationScope,
  ): Promise<Result<Turn[], InfraError>> {
    try {
      const conv = scope
        ? await this.db.runtimeConversation.findUnique({
          where: { companyId_channel_channelConversationKey: conversationUniqueKey(chatId, scope) },
          include: {
            messages: { where: { sequence: { gt: afterSequence } }, orderBy: { sequence: 'desc' }, take: limit },
          },
        })
        : await this.db.runtimeConversation.findFirst({
          where: { channelConversationKey: chatId },
          include: {
            messages: { where: { sequence: { gt: afterSequence } }, orderBy: { sequence: 'desc' }, take: limit },
          },
        });
      if (!conv) return ok([]);
      const messages = [...conv.messages].reverse();
      const turns: Turn[] = messages.map(r => ({
        id: r.id,
        role: r.role as Turn['role'],
        content: r.contentText ?? (r.contentJson !== null ? JSON.stringify(r.contentJson) : ''),
        timestamp: r.createdAt.toISOString(),
      }));
      return ok(turns);
    } catch (e) {
      return err(wrapInfra('prisma', 'getHistoryAfterSequence', e));
    }
  }
}
