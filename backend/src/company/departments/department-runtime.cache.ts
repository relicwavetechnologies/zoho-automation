import { createHash } from 'crypto';

import { cacheRedisConnection } from '../queue/runtime/redis.connection';
import { logger } from '../../utils/logger';

type CachedDepartmentRuntime = {
  departmentId?: string;
  departmentName?: string;
  departmentRoleSlug?: string;
  departmentZohoReadScope?: 'personalized' | 'show_all';
  systemPrompt?: string;
  skillsMarkdown?: string;
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, string[]>;
};

const DEPARTMENT_RUNTIME_TTL_SECONDS = 60 * 5;
const DEPARTMENT_RUNTIME_CACHE_VERSION = 'v2';

const fallbackHash = (fallbackAllowedToolIds: string[]): string =>
  createHash('sha1')
    .update([...new Set(fallbackAllowedToolIds)].sort().join(','))
    .digest('hex')
    .slice(0, 12);

const runtimeKey = (input: {
  companyId: string;
  userId: string;
  departmentId: string;
  fallbackAllowedToolIds: string[];
}) =>
  `company:${input.companyId}:department_runtime:${DEPARTMENT_RUNTIME_CACHE_VERSION}:department:${input.departmentId}:user:${input.userId}:fallback:${fallbackHash(input.fallbackAllowedToolIds)}`;

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

class DepartmentRuntimeCache {
  async get(input: {
    companyId: string;
    userId: string;
    departmentId: string;
    fallbackAllowedToolIds: string[];
  }): Promise<CachedDepartmentRuntime | null> {
    const redis = cacheRedisConnection.getClient();
    const key = runtimeKey(input);
    const cached = await redis.get(key);
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached) as CachedDepartmentRuntime;
      logger.info('department_runtime.cache.hit', {
        companyId: input.companyId,
        userId: input.userId,
        departmentId: input.departmentId,
        allowedToolCount: parsed.allowedToolIds.length,
      }, { sampleRate: 0.05 });
      return parsed;
    } catch {
      return null;
    }
  }

  async set(input: {
    companyId: string;
    userId: string;
    departmentId: string;
    fallbackAllowedToolIds: string[];
    runtime: CachedDepartmentRuntime;
  }): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    await redis.set(
      runtimeKey(input),
      JSON.stringify(input.runtime),
      'EX',
      DEPARTMENT_RUNTIME_TTL_SECONDS,
    );
    logger.info('department_runtime.cache.set', {
      companyId: input.companyId,
      userId: input.userId,
      departmentId: input.departmentId,
      allowedToolCount: input.runtime.allowedToolIds.length,
    }, { sampleRate: 0.1 });
  }

  async invalidateDepartment(companyId: string, departmentId: string): Promise<void> {
    const deleted = await invalidateByPattern(`company:${companyId}:department_runtime:department:${departmentId}:*`);
    logger.info('department_runtime.cache.invalidated', {
      companyId,
      departmentId,
      deleted,
    });
  }
}

export const departmentRuntimeCache = new DepartmentRuntimeCache();
