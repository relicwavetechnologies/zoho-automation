import { AsyncLocalStorage } from 'async_hooks';

import { cacheRedisConnection } from '../../queue/runtime/redis.connection';
import { logger } from '../../../utils/logger';
import { ZohoIntegrationError } from './zoho.errors';
import type { ZohoRateLimitConfig, ZohoRateLimitContext } from './zoho-rate-limit.types';

const contextStorage = new AsyncLocalStorage<ZohoRateLimitContext>();
const RATE_LIMIT_TTL_SKEW_SECONDS = 5;

const normalizeRoleBudgets = (
  budgets: Record<string, number> | undefined,
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(budgets ?? {})
      .map(([role, value]) => [role.trim().toUpperCase(), Math.max(1, Math.floor(value))] as const)
      .filter(([role]) => role.length > 0),
  );

const resolveUserCap = (
  config: ZohoRateLimitConfig,
  userId?: string,
  roleSlug?: string,
): number => {
  const override = userId
    ? config.userOverrides.find((entry) => entry.userId === userId)?.maxCallsPerWindow
    : undefined;
  if (override && Number.isFinite(override) && override > 0) {
    return Math.min(config.totalCallsPerWindow, Math.floor(override));
  }
  const normalizedRole = roleSlug?.trim().toUpperCase();
  const roleCap = normalizedRole ? config.roleBudgets[normalizedRole] : undefined;
  if (roleCap && Number.isFinite(roleCap) && roleCap > 0) {
    return Math.min(config.totalCallsPerWindow, Math.floor(roleCap));
  }
  return config.totalCallsPerWindow;
};

const reserveLua = `
local deptCurrent = tonumber(redis.call('GET', KEYS[1]) or '0')
local userCurrent = tonumber(redis.call('GET', KEYS[2]) or '0')
local deptCap = tonumber(ARGV[1])
local userCap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

if deptCurrent + 1 > deptCap then
  return {0, 'department', deptCurrent, userCurrent}
end

if userCurrent + 1 > userCap then
  return {0, 'user', deptCurrent, userCurrent}
end

deptCurrent = redis.call('INCR', KEYS[1])
if deptCurrent == 1 then
  redis.call('EXPIRE', KEYS[1], ttl)
end

userCurrent = redis.call('INCR', KEYS[2])
if userCurrent == 1 then
  redis.call('EXPIRE', KEYS[2], ttl)
end

return {1, deptCurrent, userCurrent}
`;

class ZohoRateLimitService {
  runWithContext<T>(context: ZohoRateLimitContext, fn: () => Promise<T>): Promise<T> {
    return contextStorage.run(context, fn);
  }

  getCurrentContext(): ZohoRateLimitContext | undefined {
    return contextStorage.getStore();
  }

  async consumeCall(input: { path: string; base: 'accounts' | 'api' }): Promise<void> {
    if (input.base !== 'api') {
      return;
    }

    const context = contextStorage.getStore();
    const config = context?.config;
    if (!context?.departmentId || !context.userId || !config?.enabled) {
      return;
    }

    const normalizedConfig: ZohoRateLimitConfig = {
      enabled: true,
      windowSeconds: Math.max(10, Math.floor(config.windowSeconds)),
      totalCallsPerWindow: Math.max(1, Math.floor(config.totalCallsPerWindow)),
      roleBudgets: normalizeRoleBudgets(config.roleBudgets),
      userOverrides: config.userOverrides
        .filter((entry) => entry.userId?.trim())
        .map((entry) => ({
          userId: entry.userId,
          maxCallsPerWindow: Math.max(1, Math.floor(entry.maxCallsPerWindow)),
        })),
    };

    const userCap = resolveUserCap(normalizedConfig, context.userId, context.departmentRoleSlug);
    const windowBucket = Math.floor(Date.now() / (normalizedConfig.windowSeconds * 1000));
    const departmentKey = [
      'zoho',
      'budget',
      context.companyId,
      context.departmentId,
      'window',
      String(windowBucket),
      'department',
    ].join(':');
    const userKey = [
      'zoho',
      'budget',
      context.companyId,
      context.departmentId,
      'window',
      String(windowBucket),
      'user',
      context.userId,
    ].join(':');

    const redis = cacheRedisConnection.getClient();
    const ttlSeconds = normalizedConfig.windowSeconds + RATE_LIMIT_TTL_SKEW_SECONDS;
    let rawResult: [number, string | number, number, number] | [number, number, number];
    try {
      rawResult = (await redis.eval(
        reserveLua,
        2,
        departmentKey,
        userKey,
        String(normalizedConfig.totalCallsPerWindow),
        String(userCap),
        String(ttlSeconds),
      )) as [number, string | number, number, number] | [number, number, number];
    } catch (error) {
      logger.warn('zoho.internal_rate_limit.lookup_failed', {
        companyId: context.companyId,
        departmentId: context.departmentId,
        userId: context.userId,
        departmentRoleSlug: context.departmentRoleSlug,
        path: input.path,
        base: input.base,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (Number(rawResult?.[0]) === 1) {
      return;
    }

    const failureScope = String(rawResult?.[1] ?? 'department');
    logger.warn('zoho.internal_rate_limit.exceeded', {
      companyId: context.companyId,
      departmentId: context.departmentId,
      userId: context.userId,
      departmentRoleSlug: context.departmentRoleSlug,
      path: input.path,
      base: input.base,
      totalCallsPerWindow: normalizedConfig.totalCallsPerWindow,
      userCap,
      failureScope,
    });
    throw new ZohoIntegrationError({
      message:
        failureScope === 'user'
          ? 'Your department Zoho call budget is exhausted for this window. Please retry shortly.'
          : 'Your department Zoho call pool is exhausted for this window. Please retry shortly.',
      code: 'rate_limited',
      retriable: true,
      statusCode: 429,
    });
  }
}

export const zohoRateLimitService = new ZohoRateLimitService();
