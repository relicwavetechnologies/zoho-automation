import { createHash } from 'crypto';

import { personalVectorMemoryService, type PersonalMemoryMatch } from '../integrations/vector';
import { cacheRedisConnection } from '../queue/runtime/redis.connection';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import {
  buildBehaviorProfileSummary,
  formatKindLabel,
  MEMORY_ROUTING_SHORT_TTL_MS,
  MEMORY_ROUTING_THREAD_TTL_MS,
  MEMORY_ROUTING_USER_TTL_MS,
  type DurableMemoryContextClass,
  type FlatUserMemoryItem,
  type MemoryPromptContext,
  type UserBehaviorProfile,
} from './contracts';
import { memoryRankingService } from './memory-ranking.service';

type TimedPromiseCacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

type SerializedFlatUserMemoryItem = Omit<FlatUserMemoryItem, 'lastSeenAt' | 'lastConfirmedAt' | 'staleAfterAt' | 'updatedAt'> & {
  lastSeenAt: string;
  lastConfirmedAt?: string | null;
  staleAfterAt?: string | null;
  updatedAt: string;
};

type SerializedPromptContext = Omit<MemoryPromptContext, 'behaviorProfile'> & {
  behaviorProfile: UserBehaviorProfile | null;
};

const profileCache = new Map<string, TimedPromiseCacheEntry<UserBehaviorProfile | null>>();
const activeRowsCache = new Map<string, TimedPromiseCacheEntry<FlatUserMemoryItem[]>>();
const promptContextCache = new Map<string, TimedPromiseCacheEntry<MemoryPromptContext>>();
const MEMORY_CACHE_VERSION = 'v1';
const toRedisTtlSeconds = (ttlMs: number): number => Math.max(1, Math.ceil(ttlMs / 1000));

const isPersonalMemoryQuestion = (value: string | null | undefined): boolean =>
  /\b(do you know|do you remember|remember|recall|what(?:'s| is) my|my (?:fav|favorite|favourite|preferred)|favorite|favourite|preferred|preference|about me|my name|my email)\b/i.test(value ?? '');

const isReferentialFollowup = (value: string | null | undefined): boolean =>
  /\b(next task|pick the next|move on|move to next|continue|next one|same file|same one|next estimate|what next)\b/i.test(value ?? '');

const expandConversationMemoryQuery = (value: string): string => {
  const normalized = value
    .replace(/\bfav\b/gi, 'favorite')
    .replace(/\blang\b/gi, 'language')
    .replace(/\bpref\b/gi, 'preference');
  return normalized === value ? value : `${value}\n${normalized}`;
};

const summarizeText = (value: string | null | undefined, limit = 280): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
};

const summarizeConversationMatches = (
  matches: PersonalMemoryMatch[],
  maxCount: number,
): string[] =>
  matches
    .slice(0, maxCount)
    .map((match) => summarizeText(match.content, 320))
    .filter((entry): entry is string => Boolean(entry));

const dedupeStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
};

const mapMemoryItem = (item: {
  id: string;
  kind: string;
  scope: string;
  subjectKey: string;
  summary: string;
  valueJson: unknown;
  confidence: number;
  status: string;
  source: string;
  threadId: string | null;
  conversationKey: string | null;
  lastSeenAt: Date;
  lastConfirmedAt: Date | null;
  staleAfterAt: Date | null;
  updatedAt: Date;
}): FlatUserMemoryItem => ({
  id: item.id,
  kind: item.kind as FlatUserMemoryItem['kind'],
  scope: item.scope as FlatUserMemoryItem['scope'],
  subjectKey: item.subjectKey,
  summary: item.summary,
  valueJson: item.valueJson && typeof item.valueJson === 'object' && !Array.isArray(item.valueJson)
    ? item.valueJson as Record<string, unknown>
    : {},
  confidence: item.confidence,
  status: item.status as FlatUserMemoryItem['status'],
  source: item.source as FlatUserMemoryItem['source'],
  threadId: item.threadId,
  conversationKey: item.conversationKey,
  lastSeenAt: item.lastSeenAt,
  lastConfirmedAt: item.lastConfirmedAt,
  staleAfterAt: item.staleAfterAt,
  updatedAt: item.updatedAt,
});

const getCachedPromiseValue = async <T>(
  cache: Map<string, TimedPromiseCacheEntry<T>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> => {
  const now = Date.now();
  for (const [entryKey, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(entryKey);
    }
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = loader().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, {
    expiresAt: now + ttlMs,
    promise,
  });
  return promise;
};

const buildProfileCacheKey = (companyId: string, userId: string): string =>
  `${companyId}:${userId}`;

const buildActiveRowsCacheKey = (input: {
  companyId: string;
  userId: string;
  threadId?: string;
  conversationKey?: string;
}): string =>
  `${input.companyId}:${input.userId}:${input.threadId ?? 'none'}:${input.conversationKey ?? 'none'}`;

const buildPromptContextCacheKey = (input: {
  companyId: string;
  userId: string;
  threadId?: string;
  conversationKey?: string;
  queryText: string;
  contextClass: DurableMemoryContextClass;
}): string =>
  `${buildActiveRowsCacheKey(input)}:${input.contextClass}:${input.queryText.trim().toLowerCase()}`;

const redisProfileKey = (companyId: string, userId: string): string =>
  `company:${companyId}:memory:${MEMORY_CACHE_VERSION}:user:${userId}:profile`;

const redisActiveRowsKey = (input: {
  companyId: string;
  userId: string;
  threadId?: string;
  conversationKey?: string;
}): string =>
  `company:${input.companyId}:memory:${MEMORY_CACHE_VERSION}:user:${input.userId}:active:${input.threadId ?? 'none'}:${input.conversationKey ?? 'none'}`;

const redisPromptContextKey = (input: {
  companyId: string;
  userId: string;
  threadId?: string;
  conversationKey?: string;
  queryText: string;
  contextClass: DurableMemoryContextClass;
}): string =>
  `company:${input.companyId}:memory:${MEMORY_CACHE_VERSION}:user:${input.userId}:prompt:${input.threadId ?? 'none'}:${input.conversationKey ?? 'none'}:${input.contextClass}:${createHash('sha1').update(input.queryText.trim().toLowerCase()).digest('hex').slice(0, 16)}`;

const parseProfile = (serialized: string | null): UserBehaviorProfile | null | undefined => {
  if (serialized === null) {
    return undefined;
  }
  if (serialized === 'null') {
    return null;
  }
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      preferredReplyLength: typeof record.preferredReplyLength === 'string' ? record.preferredReplyLength as UserBehaviorProfile['preferredReplyLength'] : undefined,
      preferredTone: typeof record.preferredTone === 'string' ? record.preferredTone as UserBehaviorProfile['preferredTone'] : undefined,
      preferredFormatting: typeof record.preferredFormatting === 'string' ? record.preferredFormatting as UserBehaviorProfile['preferredFormatting'] : undefined,
      updatedFromMemoryItemId: typeof record.updatedFromMemoryItemId === 'string' ? record.updatedFromMemoryItemId : null,
    };
  } catch {
    return null;
  }
};

const serializeFlatItem = (item: FlatUserMemoryItem): SerializedFlatUserMemoryItem => ({
  ...item,
  lastSeenAt: item.lastSeenAt.toISOString(),
  lastConfirmedAt: item.lastConfirmedAt?.toISOString() ?? null,
  staleAfterAt: item.staleAfterAt?.toISOString() ?? null,
  updatedAt: item.updatedAt.toISOString(),
});

const deserializeFlatItem = (item: SerializedFlatUserMemoryItem): FlatUserMemoryItem => ({
  ...item,
  lastSeenAt: new Date(item.lastSeenAt),
  lastConfirmedAt: item.lastConfirmedAt ? new Date(item.lastConfirmedAt) : null,
  staleAfterAt: item.staleAfterAt ? new Date(item.staleAfterAt) : null,
  updatedAt: new Date(item.updatedAt),
});

const parseActiveItems = (serialized: string | null): FlatUserMemoryItem[] | undefined => {
  if (serialized === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [];
      }
      return [deserializeFlatItem(value as SerializedFlatUserMemoryItem)];
    });
  } catch {
    return [];
  }
};

const parsePromptContext = (serialized: string | null): MemoryPromptContext | undefined => {
  if (serialized === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(serialized) as SerializedPromptContext;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        behaviorProfile: null,
        behaviorProfileContext: null,
        durableTaskContext: [],
        durableTaskContextText: null,
        relevantMemoryFacts: [],
        relevantMemoryFactsText: null,
      };
    }
    return {
      behaviorProfile: parsed.behaviorProfile ?? null,
      behaviorProfileContext: typeof parsed.behaviorProfileContext === 'string' ? parsed.behaviorProfileContext : null,
      durableTaskContext: Array.isArray(parsed.durableTaskContext) ? parsed.durableTaskContext.filter((value): value is string => typeof value === 'string') : [],
      durableTaskContextText: typeof parsed.durableTaskContextText === 'string' ? parsed.durableTaskContextText : null,
      relevantMemoryFacts: Array.isArray(parsed.relevantMemoryFacts) ? parsed.relevantMemoryFacts.filter((value): value is string => typeof value === 'string') : [],
      relevantMemoryFactsText: typeof parsed.relevantMemoryFactsText === 'string' ? parsed.relevantMemoryFactsText : null,
    };
  } catch {
    return {
      behaviorProfile: null,
      behaviorProfileContext: null,
      durableTaskContext: [],
      durableTaskContextText: null,
      relevantMemoryFacts: [],
      relevantMemoryFactsText: null,
    };
  }
};

const invalidateByPattern = async (pattern: string): Promise<number> => {
  const redis = cacheRedisConnection.getClient();
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
};

class MemoryContextService {
  async getActiveMemoryState(input: {
    companyId: string;
    userId: string;
    threadId?: string;
    conversationKey?: string;
  }): Promise<{
    profile: UserBehaviorProfile | null;
    activeItems: FlatUserMemoryItem[];
  }> {
    const profileCacheKey = buildProfileCacheKey(input.companyId, input.userId);
    const activeRowsCacheKey = buildActiveRowsCacheKey(input);
    const [profile, activeItems] = await Promise.all([
      getCachedPromiseValue(profileCache, profileCacheKey, MEMORY_ROUTING_USER_TTL_MS, async () => {
        const redis = cacheRedisConnection.getClient();
        const cached = parseProfile(await redis.get(redisProfileKey(input.companyId, input.userId)));
        if (cached !== undefined) {
          await redis.expire(redisProfileKey(input.companyId, input.userId), toRedisTtlSeconds(MEMORY_ROUTING_USER_TTL_MS));
          return cached;
        }
        const profileRow = await prisma.userMemoryProfile.findUnique({
          where: {
            companyId_userId: {
              companyId: input.companyId,
              userId: input.userId,
            },
          },
        });
        const profile: UserBehaviorProfile | null = profileRow
          ? {
            preferredReplyLength: profileRow.preferredReplyLength ?? undefined,
            preferredTone: profileRow.preferredTone ?? undefined,
            preferredFormatting: profileRow.preferredFormatting ?? undefined,
            updatedFromMemoryItemId: profileRow.updatedFromMemoryItemId ?? null,
          }
          : null;
        await redis.set(
          redisProfileKey(input.companyId, input.userId),
          JSON.stringify(profile),
          'EX',
          toRedisTtlSeconds(MEMORY_ROUTING_USER_TTL_MS),
        );
        return profile;
      }),
      getCachedPromiseValue(activeRowsCache, activeRowsCacheKey, MEMORY_ROUTING_THREAD_TTL_MS, async () => {
        const redis = cacheRedisConnection.getClient();
        const cached = parseActiveItems(await redis.get(redisActiveRowsKey(input)));
        if (cached !== undefined) {
          await redis.expire(redisActiveRowsKey(input), toRedisTtlSeconds(MEMORY_ROUTING_THREAD_TTL_MS));
          return cached;
        }
        const rows = await prisma.userMemoryItem.findMany({
          where: {
            companyId: input.companyId,
            userId: input.userId,
            status: 'active',
            OR: [
              { scope: 'user_global' },
              {
                scope: 'thread_pinned',
                threadId: input.threadId ?? null,
              },
              {
                scope: 'thread_pinned',
                conversationKey: input.conversationKey ?? null,
              },
            ],
          },
          orderBy: {
            updatedAt: 'desc',
          },
          select: {
            id: true,
            kind: true,
            scope: true,
            subjectKey: true,
            summary: true,
            valueJson: true,
            confidence: true,
            status: true,
            source: true,
            threadId: true,
            conversationKey: true,
            lastSeenAt: true,
            lastConfirmedAt: true,
            staleAfterAt: true,
            updatedAt: true,
          },
        });
        await redis.set(
          redisActiveRowsKey(input),
          JSON.stringify(rows.map((row) => serializeFlatItem(mapMemoryItem(row)))),
          'EX',
          toRedisTtlSeconds(MEMORY_ROUTING_THREAD_TTL_MS),
        );
        return rows.map(mapMemoryItem);
      }),
    ]);
    return {
      profile,
      activeItems,
    };
  }

  async invalidateCache(input: {
    companyId: string;
    userId: string;
    threadId?: string;
    conversationKey?: string;
  }): Promise<void> {
    const profilePrefix = buildProfileCacheKey(input.companyId, input.userId);
    profileCache.delete(profilePrefix);
    const activePrefix = buildActiveRowsCacheKey(input);
    for (const key of activeRowsCache.keys()) {
      if (key.startsWith(profilePrefix)) {
        if (!input.threadId && !input.conversationKey) {
          activeRowsCache.delete(key);
          continue;
        }
        if (key.startsWith(activePrefix)) {
          activeRowsCache.delete(key);
        }
      }
    }
    for (const key of promptContextCache.keys()) {
      if (key.startsWith(profilePrefix)) {
        if (!input.threadId && !input.conversationKey) {
          promptContextCache.delete(key);
          continue;
        }
        if (key.startsWith(activePrefix)) {
          promptContextCache.delete(key);
        }
      }
    }
    const deleted = await Promise.all([
      cacheRedisConnection.getClient().del(redisProfileKey(input.companyId, input.userId)),
      invalidateByPattern(`company:${input.companyId}:memory:${MEMORY_CACHE_VERSION}:user:${input.userId}:active:*`),
      invalidateByPattern(`company:${input.companyId}:memory:${MEMORY_CACHE_VERSION}:user:${input.userId}:prompt:*`),
    ]);
    logger.info('memory.cache.invalidated', {
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId ?? null,
      conversationKey: input.conversationKey ?? null,
      deleted: deleted.reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0),
    }, { sampleRate: 0.1 });
  }

  async buildPromptContext(input: {
    companyId: string;
    userId?: string | null;
    threadId?: string;
    conversationKey?: string;
    queryText: string;
    contextClass: DurableMemoryContextClass;
  }): Promise<MemoryPromptContext> {
    if (!input.userId) {
      return {
        behaviorProfile: null,
        behaviorProfileContext: null,
        durableTaskContext: [],
        durableTaskContextText: null,
        relevantMemoryFacts: [],
        relevantMemoryFactsText: null,
      };
    }

    const promptContextCacheKey = buildPromptContextCacheKey({
      companyId: input.companyId,
      userId: input.userId,
      threadId: input.threadId,
      conversationKey: input.conversationKey,
      queryText: input.queryText,
      contextClass: input.contextClass,
    });
    return getCachedPromiseValue(promptContextCache, promptContextCacheKey, MEMORY_ROUTING_SHORT_TTL_MS, async () => {
      const redis = cacheRedisConnection.getClient();
      const redisKey = redisPromptContextKey({
        companyId: input.companyId,
        userId: input.userId!,
        threadId: input.threadId,
        conversationKey: input.conversationKey,
        queryText: input.queryText,
        contextClass: input.contextClass,
      });
      const cachedContext = parsePromptContext(await redis.get(redisKey));
      if (cachedContext !== undefined) {
        await redis.expire(redisKey, toRedisTtlSeconds(MEMORY_ROUTING_SHORT_TTL_MS));
        return cachedContext;
      }

      const { profile, activeItems } = await this.getActiveMemoryState({
        companyId: input.companyId,
        userId: input.userId!,
        threadId: input.threadId,
        conversationKey: input.conversationKey,
      });
      const behaviorProfile = profile;

      const durableTaskItems = activeItems.filter((item) =>
        item.kind === 'ongoing_task'
        || item.kind === 'project'
        || item.kind === 'decision'
        || item.kind === 'constraint');

      const relevantStructured = memoryRankingService.rankRelevant({
        mode: 'off',
        queryText: input.queryText,
        items: activeItems.filter((item) => item.kind !== 'response_style' && item.kind !== 'tool_routing'),
        limit: 6,
      }).map((item) => `${formatKindLabel(item.kind)}: ${item.summary}`);

      const vectorSnippets = await this.retrieveVectorMemory({
        companyId: input.companyId,
        userId: input.userId!,
        conversationKey: input.conversationKey,
        queryText: input.queryText,
        contextClass: input.contextClass,
      });

      const durableTaskContext = dedupeStrings(
        durableTaskItems
          .slice(0, 6)
          .map((item) => `${formatKindLabel(item.kind)}: ${item.summary}`),
      );
      const relevantMemoryFacts = dedupeStrings([
        ...relevantStructured,
        ...vectorSnippets,
      ]).slice(0, 8);

      const behaviorSummary = buildBehaviorProfileSummary(behaviorProfile);

      const promptContext = {
        behaviorProfile,
        behaviorProfileContext: behaviorSummary
          ? `Resolved user behavior profile: ${behaviorSummary}. This should shape the response from the start unless the latest user message overrides it.`
          : null,
        durableTaskContext,
        durableTaskContextText: durableTaskContext.length > 0 ? durableTaskContext.map((entry) => `- ${entry}`).join('\n') : null,
        relevantMemoryFacts,
        relevantMemoryFactsText: relevantMemoryFacts.length > 0 ? relevantMemoryFacts.map((entry) => `- ${entry}`).join('\n') : null,
      };
      await redis.set(
        redisKey,
        JSON.stringify(promptContext),
        'EX',
        toRedisTtlSeconds(MEMORY_ROUTING_SHORT_TTL_MS),
      );
      return promptContext;
    });
  }

  private async retrieveVectorMemory(input: {
    companyId: string;
    userId: string;
    conversationKey?: string;
    queryText: string;
    contextClass: DurableMemoryContextClass;
  }): Promise<string[]> {
    const isMemoryQuestion = isPersonalMemoryQuestion(input.queryText);
    if (
      !input.queryText.trim()
      || (
        input.contextClass === 'lightweight_chat'
        && !isMemoryQuestion
        && !isReferentialFollowup(input.queryText)
      )
    ) {
      return [];
    }

    const limit = isMemoryQuestion ? 4 : 3;
    const scopedMatches = await personalVectorMemoryService.query({
      companyId: input.companyId,
      requesterUserId: input.userId,
      conversationKey: input.conversationKey,
      text: isMemoryQuestion ? expandConversationMemoryQuery(input.queryText) : input.queryText,
      limit,
    });

    if (scopedMatches.length > 0 || !isMemoryQuestion) {
      return dedupeStrings(summarizeConversationMatches(scopedMatches, limit));
    }

    const globalMatches = await personalVectorMemoryService.query({
      companyId: input.companyId,
      requesterUserId: input.userId,
      text: expandConversationMemoryQuery(input.queryText),
      limit,
    });
    return dedupeStrings(summarizeConversationMatches(globalMatches, limit));
  }
}

export const memoryContextService = new MemoryContextService();
