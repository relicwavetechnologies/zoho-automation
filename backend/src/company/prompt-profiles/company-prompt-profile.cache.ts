import { cacheRedisConnection } from '../queue/runtime/redis.connection';
import { logger } from '../../utils/logger';

export type CompanyPromptProfileRuntime = {
  companyId: string;
  companyContext: string;
  systemsOfRecord: string;
  businessRules: string;
  communicationStyle: string;
  formattingDefaults: string;
  restrictedClaims: string;
  isActive: boolean;
  revisionHash: string;
  hasContent: boolean;
};

const COMPANY_PROMPT_PROFILE_TTL_SECONDS = 60 * 5;
const COMPANY_PROMPT_PROFILE_CACHE_VERSION = 'v1';

const runtimeKey = (companyId: string) =>
  `company:${companyId}:prompt_profile:${COMPANY_PROMPT_PROFILE_CACHE_VERSION}`;

class CompanyPromptProfileCache {
  async get(companyId: string): Promise<CompanyPromptProfileRuntime | null> {
    const redis = cacheRedisConnection.getClient();
    const cached = await redis.get(runtimeKey(companyId));
    if (!cached) {
      logger.info('company_prompt_profile.cache.miss', { companyId }, { sampleRate: 0.1 });
      return null;
    }
    try {
      const parsed = JSON.parse(cached) as CompanyPromptProfileRuntime;
      logger.info('company_prompt_profile.cache.hit', { companyId }, { sampleRate: 0.1 });
      return parsed;
    } catch {
      return null;
    }
  }

  async set(profile: CompanyPromptProfileRuntime): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    await redis.set(runtimeKey(profile.companyId), JSON.stringify(profile), 'EX', COMPANY_PROMPT_PROFILE_TTL_SECONDS);
    logger.info('company_prompt_profile.cache.set', {
      companyId: profile.companyId,
      hasContent: profile.hasContent,
      isActive: profile.isActive,
    }, { sampleRate: 0.1 });
  }

  async invalidate(companyId: string): Promise<void> {
    const redis = cacheRedisConnection.getClient();
    await redis.del(runtimeKey(companyId));
    logger.info('company_prompt_profile.cache.invalidated', { companyId });
  }
}

export const companyPromptProfileCache = new CompanyPromptProfileCache();
