import { logger } from '../../../../../utils/logger';
import type { VercelRuntimeRequestContext } from '../../types';

const LARK_LOCAL_TIME_ZONE = 'Asia/Kolkata';

export const getLarkDefaults = async (
  runtime: VercelRuntimeRequestContext,
  deps: {
    loadLarkOperationalConfigRepository: () => {
      findByCompanyId: (companyId: string) => Promise<unknown>;
    };
  },
) => deps.loadLarkOperationalConfigRepository().findByCompanyId(runtime.companyId);

export const getLarkAuthInput = (runtime: VercelRuntimeRequestContext) => {
  const authInput = {
    companyId: runtime.companyId,
    larkTenantKey: runtime.larkTenantKey,
    appUserId: runtime.userId,
    credentialMode:
      runtime.authProvider === 'lark' ? ('user_linked' as const) : ('tenant' as const),
  };

  logger.info('vercel.lark.auth.selected', {
    executionId: runtime.executionId,
    threadId: runtime.threadId,
    companyId: runtime.companyId,
    userId: runtime.userId,
    authProvider: runtime.authProvider,
    credentialMode: authInput.credentialMode,
    hasLarkTenantKey: Boolean(runtime.larkTenantKey),
    hasLarkOpenId: Boolean(runtime.larkOpenId),
    hasLarkUserId: Boolean(runtime.larkUserId),
  });

  return authInput;
};

export const getLarkTimeZone = (): string => LARK_LOCAL_TIME_ZONE;

export const withLarkTenantFallback = async <T>(
  runtime: VercelRuntimeRequestContext,
  run: (auth: Record<string, unknown>) => Promise<T>,
  deps: {
    loadLarkRuntimeClientError: () => new (...args: any[]) => Error;
  },
): Promise<T> => {
  const primary = getLarkAuthInput(runtime);
  try {
    return await run(primary);
  } catch (error) {
    const LarkRuntimeClientError = deps.loadLarkRuntimeClientError();
    if (primary.credentialMode !== 'user_linked' || !(error instanceof LarkRuntimeClientError)) {
      throw error;
    }
    logger.warn('vercel.lark.auth.fallback_to_tenant', {
      executionId: runtime.executionId,
      threadId: runtime.threadId,
      companyId: runtime.companyId,
      userId: runtime.userId,
      error: error.message,
    });
    return run({
      ...primary,
      credentialMode: 'tenant',
    });
  }
};
