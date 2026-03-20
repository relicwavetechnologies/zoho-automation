import { redisConnection } from '../../company/queue/runtime/redis.connection';
import { logger } from '../../utils/logger';

export type CachedDesktopThreadMeta = {
  id: string;
  userId: string;
  companyId: string;
  title?: string | null;
  departmentId?: string | null;
  department?: {
    id: string;
    name: string;
    slug: string;
  } | null;
  lastMessageAt?: string | null;
  cachedAt: string;
};

const DESKTOP_THREAD_META_TTL_SECONDS = 60 * 15;

const metaKey = (threadId: string, userId: string) =>
  `desktop:thread:${threadId}:user:${userId}:meta`;

const parseMeta = (serialized: string | null): CachedDesktopThreadMeta | null => {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== 'string'
      || typeof record.userId !== 'string'
      || typeof record.companyId !== 'string'
    ) {
      return null;
    }
    const department = record.department;
    return {
      id: record.id,
      userId: record.userId,
      companyId: record.companyId,
      title: typeof record.title === 'string' ? record.title : null,
      departmentId: typeof record.departmentId === 'string' ? record.departmentId : null,
      department: department && typeof department === 'object' && !Array.isArray(department)
        && typeof (department as Record<string, unknown>).id === 'string'
        && typeof (department as Record<string, unknown>).name === 'string'
        && typeof (department as Record<string, unknown>).slug === 'string'
        ? {
          id: (department as Record<string, unknown>).id as string,
          name: (department as Record<string, unknown>).name as string,
          slug: (department as Record<string, unknown>).slug as string,
        }
        : null,
      lastMessageAt: typeof record.lastMessageAt === 'string' ? record.lastMessageAt : null,
      cachedAt: typeof record.cachedAt === 'string' ? record.cachedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
};

class DesktopThreadMetaCache {
  private async save(meta: CachedDesktopThreadMeta): Promise<void> {
    const redis = redisConnection.getClient();
    await redis.set(
      metaKey(meta.id, meta.userId),
      JSON.stringify({
        ...meta,
        cachedAt: new Date().toISOString(),
      }),
      'EX',
      DESKTOP_THREAD_META_TTL_SECONDS,
    );
  }

  async getOrLoad(input: {
    threadId: string;
    userId: string;
    loader: () => Promise<CachedDesktopThreadMeta>;
  }): Promise<CachedDesktopThreadMeta> {
    const redis = redisConnection.getClient();
    const key = metaKey(input.threadId, input.userId);
    const cached = parseMeta(await redis.get(key));
    if (cached) {
      await redis.expire(key, DESKTOP_THREAD_META_TTL_SECONDS);
      logger.info('desktop.thread_meta.cache.hit', {
        threadId: input.threadId,
        userId: input.userId,
        departmentId: cached.departmentId ?? null,
      });
      return cached;
    }

    logger.info('desktop.thread_meta.cache.miss', {
      threadId: input.threadId,
      userId: input.userId,
    });
    const loaded = await input.loader();
    await this.save(loaded);
    return loaded;
  }

  async set(meta: CachedDesktopThreadMeta): Promise<void> {
    await this.save(meta);
    logger.info('desktop.thread_meta.cache.set', {
      threadId: meta.id,
      userId: meta.userId,
      departmentId: meta.departmentId ?? null,
    });
  }

  async invalidate(threadId: string, userId: string): Promise<void> {
    const redis = redisConnection.getClient();
    await redis.del(metaKey(threadId, userId));
    logger.info('desktop.thread_meta.cache.invalidated', {
      threadId,
      userId,
    });
  }
}

export const desktopThreadMetaCache = new DesktopThreadMetaCache();
