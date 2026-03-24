import { createHash } from 'crypto';

import { cacheRedisConnection } from '../queue/runtime/redis.connection';
import { logger } from '../../utils/logger';

const TOOL_ACCESS_CACHE_TTL_SECONDS = 60 * 5;

const allowedToolsKey = (companyId: string, role: string) =>
  `company:${companyId}:tool_access:allowed_tools:${role}`;

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

class ToolAccessCache {
  async getAllowedTools(companyId: string, role: string): Promise<string[] | null> {
    const redis = cacheRedisConnection.getClient();
    const cached = await redis.get(allowedToolsKey(companyId, role));
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (!Array.isArray(parsed)) return null;
      const values = parsed.filter((value): value is string => typeof value === 'string');
      await redis.expire(allowedToolsKey(companyId, role), TOOL_ACCESS_CACHE_TTL_SECONDS);
      logger.info('tool_access.cache.hit', {
        companyId,
        role,
        toolCount: values.length,
      }, { sampleRate: 0.05 });
      return values;
    } catch {
      return null;
    }
  }

  async setAllowedTools(companyId: string, role: string, toolIds: string[]): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    const normalized = [...new Set(toolIds)].sort();
    await redis.set(
      allowedToolsKey(companyId, role),
      JSON.stringify(normalized),
      'EX',
      TOOL_ACCESS_CACHE_TTL_SECONDS,
    );
    logger.info('tool_access.cache.set', {
      companyId,
      role,
      toolCount: normalized.length,
      hash: createHash('sha1').update(normalized.join(',')).digest('hex').slice(0, 12),
    }, { sampleRate: 0.1 });
  }

  async set(companyId: string, role: string, toolIds: string[]): Promise<void> {
    await this.setAllowedTools(companyId, role, toolIds);
  }

  async invalidateCompany(companyId: string): Promise<void> {
    const deleted = await invalidateByPattern(`company:${companyId}:tool_access:*`);
    logger.info('tool_access.cache.invalidated', {
      companyId,
      deleted,
    });
  }
}

export const toolAccessCache = new ToolAccessCache();
