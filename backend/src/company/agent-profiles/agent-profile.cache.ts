import { cacheRedisConnection } from '../queue/runtime/redis.connection';
import { logger } from '../../utils/logger';

export type CompanyAgentProfileRuntime = {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelKey: string;
  toolIds: string[];
  routingHints: string[];
  departmentIds: string[];
  isActive: boolean;
  isSeeded: boolean;
  revisionHash: string;
};

const COMPANY_AGENT_PROFILE_TTL_SECONDS = 60 * 5;
const COMPANY_AGENT_PROFILE_CACHE_VERSION = 'v1';

const runtimeKey = (companyId: string) =>
  `company:${companyId}:agent_profiles:${COMPANY_AGENT_PROFILE_CACHE_VERSION}`;

class CompanyAgentProfileCache {
  async get(companyId: string): Promise<CompanyAgentProfileRuntime[] | null> {
    const redis = cacheRedisConnection.getClient();
    const cached = await redis.get(runtimeKey(companyId));
    if (!cached) {
      logger.info('company_agent_profiles.cache.miss', { companyId }, { sampleRate: 0.1 });
      return null;
    }
    try {
      const parsed = JSON.parse(cached) as CompanyAgentProfileRuntime[];
      logger.info('company_agent_profiles.cache.hit', { companyId, count: parsed.length }, { sampleRate: 0.1 });
      return parsed;
    } catch {
      return null;
    }
  }

  async set(companyId: string, profiles: CompanyAgentProfileRuntime[]): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    await redis.set(runtimeKey(companyId), JSON.stringify(profiles), 'EX', COMPANY_AGENT_PROFILE_TTL_SECONDS);
    logger.info('company_agent_profiles.cache.set', { companyId, count: profiles.length }, { sampleRate: 0.1 });
  }

  async invalidate(companyId: string): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    await redis.del(runtimeKey(companyId));
    logger.info('company_agent_profiles.cache.invalidated', { companyId });
  }
}

export const companyAgentProfileCache = new CompanyAgentProfileCache();
