import { createHash } from 'crypto';

import { cacheRedisConnection } from '../../queue/runtime/redis.connection';
import { logger } from '../../../utils/logger';

export type StaticPromptLayerMetadata = {
  cacheNamespace: 'shared-agent' | 'supervisor';
  cacheHit: boolean;
  keyHash: string;
  keySummary: {
    version: string;
    companyId: string;
    departmentId?: string | null;
    allowedToolHash: string;
    companyProfileHash: string;
    departmentProfileHash: string;
    runtimeLabelHash?: string;
  };
};

const STATIC_PROMPT_CACHE_TTL_SECONDS = 60 * 5;
const STATIC_PROMPT_CACHE_VERSION = 'v1';

const hashValue = (value: string): string =>
  createHash('sha1').update(value).digest('hex').slice(0, 12);

const hashList = (items: string[] | undefined): string =>
  hashValue(JSON.stringify([...(items ?? [])].sort()));

const buildKey = (input: {
  namespace: StaticPromptLayerMetadata['cacheNamespace'];
  companyId: string;
  departmentId?: string | null;
  allowedToolIds?: string[];
  companyProfileHash?: string;
  departmentProfileHash?: string;
  runtimeLabel?: string;
}): {
  redisKey: string;
  keyHash: string;
  keySummary: StaticPromptLayerMetadata['keySummary'];
} => {
  const keySummary = {
    version: STATIC_PROMPT_CACHE_VERSION,
    companyId: input.companyId,
    departmentId: input.departmentId ?? null,
    allowedToolHash: hashList(input.allowedToolIds),
    companyProfileHash: input.companyProfileHash ?? 'none',
    departmentProfileHash: input.departmentProfileHash ?? 'none',
    runtimeLabelHash: input.runtimeLabel ? hashValue(input.runtimeLabel) : undefined,
  };
  const serialized = JSON.stringify({
    namespace: input.namespace,
    ...keySummary,
  });
  const keyHash = hashValue(serialized);
  return {
    redisKey: `prompt_static:${input.namespace}:${STATIC_PROMPT_CACHE_VERSION}:${keyHash}`,
    keyHash,
    keySummary,
  };
};

export const getOrBuildStaticPromptLayer = async (input: {
  namespace: StaticPromptLayerMetadata['cacheNamespace'];
  companyId: string;
  departmentId?: string | null;
  allowedToolIds?: string[];
  companyProfileHash?: string;
  departmentProfileHash?: string;
  runtimeLabel?: string;
  builder: () => string;
}): Promise<{ layer: string; metadata: StaticPromptLayerMetadata }> => {
  const { redisKey, keyHash, keySummary } = buildKey(input);
  const redis = cacheRedisConnection.getClient();
  const cached = await redis.get(redisKey);
  if (cached) {
    logger.info('prompt_static.cache.hit', {
      namespace: input.namespace,
      companyId: input.companyId,
      departmentId: input.departmentId ?? null,
      keyHash,
    }, { sampleRate: 0.1 });
    return {
      layer: cached,
      metadata: {
        cacheNamespace: input.namespace,
        cacheHit: true,
        keyHash,
        keySummary,
      },
    };
  }

  const layer = input.builder();
  await redis.set(redisKey, layer, 'EX', STATIC_PROMPT_CACHE_TTL_SECONDS);
  logger.info('prompt_static.cache.miss', {
    namespace: input.namespace,
    companyId: input.companyId,
    departmentId: input.departmentId ?? null,
    keyHash,
  }, { sampleRate: 0.1 });
  return {
    layer,
    metadata: {
      cacheNamespace: input.namespace,
      cacheHit: false,
      keyHash,
      keySummary,
    },
  };
};
