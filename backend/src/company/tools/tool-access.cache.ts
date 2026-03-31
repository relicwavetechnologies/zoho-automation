import { createHash } from 'crypto';

import { cacheRedisConnection } from '../queue/runtime/redis.connection';
import { logger } from '../../utils/logger';

const TOOL_ACCESS_CACHE_TTL_SECONDS = 60 * 5;

const allowedToolsKey = (companyId: string, role: string) =>
  `company:${companyId}:tool_access:allowed_tools:${role}`;

const allowedActionsKey = (companyId: string, role: string) =>
  `company:${companyId}:tool_access:allowed_actions:${role}`;

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

  async getAllowedActions(companyId: string, role: string): Promise<Record<string, string[]> | null> {
    const redis = cacheRedisConnection.getClient();
    const cached = await redis.get(allowedActionsKey(companyId, role));
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      const normalized = Object.fromEntries(
        Object.entries(parsed)
          .filter(([, value]) => Array.isArray(value))
          .map(([toolId, value]) => [
            toolId,
            (value as unknown[]).filter((entry): entry is string => typeof entry === 'string'),
          ]),
      );
      logger.info('tool_access.actions.cache.hit', {
        companyId,
        role,
        toolCount: Object.keys(normalized).length,
      }, { sampleRate: 0.05 });
      return normalized;
    } catch {
      return null;
    }
  }

  async setAllowedActions(
    companyId: string,
    role: string,
    data: Record<string, string[]>,
  ): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    const normalized = Object.fromEntries(
      Object.entries(data)
        .map(([toolId, actionGroups]) => [toolId, [...new Set(actionGroups)].sort()])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    await redis.set(
      allowedActionsKey(companyId, role),
      JSON.stringify(normalized),
      'EX',
      TOOL_ACCESS_CACHE_TTL_SECONDS,
    );
    logger.info('tool_access.actions.cache.set', {
      companyId,
      role,
      toolCount: Object.keys(normalized).length,
      hash: createHash('sha1').update(JSON.stringify(normalized)).digest('hex').slice(0, 12),
    }, { sampleRate: 0.1 });
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
