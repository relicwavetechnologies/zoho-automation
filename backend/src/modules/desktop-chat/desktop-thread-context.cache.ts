import { cacheRedisConnection } from '../../company/queue/runtime/redis.connection';
import { logger } from '../../utils/logger';

export type CachedDesktopThreadMessage = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

export type CachedDesktopThreadContext = {
  threadId: string;
  userId: string;
  messages: CachedDesktopThreadMessage[];
  cachedAt: string;
};

const DESKTOP_THREAD_CONTEXT_TTL_SECONDS = 60 * 15;
export const DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT = 120;

const contextKey = (threadId: string, userId: string) =>
  `desktop:thread:${threadId}:user:${userId}:context`;

const trimMessages = (
  messages: CachedDesktopThreadMessage[],
  maxMessages = DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT,
): CachedDesktopThreadMessage[] =>
  messages.slice(-Math.max(1, Math.min(DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT, maxMessages)));

const parseContext = (serialized: string | null, maxMessages = DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT): CachedDesktopThreadContext | null => {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.threadId !== 'string' || typeof record.userId !== 'string' || !Array.isArray(record.messages)) {
      return null;
    }
    const messages = record.messages.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.id !== 'string' || typeof candidate.role !== 'string' || typeof candidate.content !== 'string') {
        return [];
      }
      return [{
        id: candidate.id,
        role: candidate.role,
        content: candidate.content,
        metadata: candidate.metadata && typeof candidate.metadata === 'object' && !Array.isArray(candidate.metadata)
          ? candidate.metadata as Record<string, unknown>
          : undefined,
      }];
    });
    return {
      threadId: record.threadId,
      userId: record.userId,
      messages: trimMessages(messages, maxMessages),
      cachedAt: typeof record.cachedAt === 'string' ? record.cachedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
};

class DesktopThreadContextCache {
  private async save(context: CachedDesktopThreadContext, maxMessages = DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    const payload: CachedDesktopThreadContext = {
      ...context,
      messages: trimMessages(context.messages, maxMessages),
      cachedAt: new Date().toISOString(),
    };
    await redis.set(
      contextKey(payload.threadId, payload.userId),
      JSON.stringify(payload),
      'EX',
      DESKTOP_THREAD_CONTEXT_TTL_SECONDS,
    );
  }

  async getOrLoad(input: {
    threadId: string;
    userId: string;
    maxMessages?: number;
    loader: () => Promise<CachedDesktopThreadContext>;
  }): Promise<CachedDesktopThreadContext> {
    const redis = cacheRedisConnection.getClient();
    const key = contextKey(input.threadId, input.userId);
    const maxMessages = input.maxMessages ?? DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT;
    const cached = parseContext(await redis.get(key), maxMessages);
    if (cached) {
      logger.info('desktop.thread_context.cache.hit', {
        threadId: input.threadId,
        userId: input.userId,
        messageCount: cached.messages.length,
      }, { sampleRate: 0.05 });
      return cached;
    }

    logger.info('desktop.thread_context.cache.miss', {
      threadId: input.threadId,
      userId: input.userId,
    });
    const loaded = input.loader();
    const context = await loaded;
    await this.save(context, maxMessages);
    return context;
  }

  async appendMessage(input: {
    threadId: string;
    userId: string;
    message: CachedDesktopThreadMessage;
    maxMessages?: number;
  }): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    const key = contextKey(input.threadId, input.userId);
    const maxMessages = input.maxMessages ?? DESKTOP_THREAD_CONTEXT_MESSAGE_LIMIT;
    const existing = parseContext(await redis.get(key), maxMessages);

    if (!existing) {
      logger.info('desktop.thread_context.cache.append_skipped', {
        threadId: input.threadId,
        userId: input.userId,
        reason: 'cache_missing',
      }, { sampleRate: 0.1 });
      return;
    }

    const deduped = existing.messages.filter((message) => message.id !== input.message.id);
    const next: CachedDesktopThreadContext = {
      ...existing,
      messages: trimMessages([...deduped, input.message], maxMessages),
      cachedAt: new Date().toISOString(),
    };
    await this.save(next, maxMessages);
    logger.info('desktop.thread_context.cache.updated', {
      threadId: input.threadId,
      userId: input.userId,
      messageCount: next.messages.length,
      role: input.message.role,
    }, { sampleRate: 0.05 });
  }

  async invalidate(threadId: string, userId: string): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    await redis.del(contextKey(threadId, userId));
    logger.info('desktop.thread_context.cache.invalidated', {
      threadId,
      userId,
    });
  }
}

export const desktopThreadContextCache = new DesktopThreadContextCache();
