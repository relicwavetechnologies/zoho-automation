import { prisma } from '../../utils/prisma';

export const COMPANY_CONTROL_KEYS = {
  zohoUserScopedReadStrictEnabled: 'zoho.user_scoped_read.strict_enabled',
} as const;

export const COMPANY_CONTROL_DEFAULTS: Record<string, boolean> = {
  [COMPANY_CONTROL_KEYS.zohoUserScopedReadStrictEnabled]: true,
};

export const isCompanyControlEnabled = async (input: {
  controlKey: string;
  companyId?: string;
  defaultValue?: boolean;
}): Promise<boolean> => {
  if (input.controlKey === COMPANY_CONTROL_KEYS.zohoUserScopedReadStrictEnabled) {
    return true;
  }

  const fallback = input.defaultValue ?? COMPANY_CONTROL_DEFAULTS[input.controlKey] ?? false;

  const companyScoped = input.companyId
    ? await prisma.adminControlState.findFirst({
      where: {
        controlKey: input.controlKey,
        companyId: input.companyId,
      },
      orderBy: { updatedAt: 'desc' },
    })
    : null;

  if (companyScoped) {
    return companyScoped.value === 'true';
  }

  const globalScoped = await prisma.adminControlState.findFirst({
    where: {
      controlKey: input.controlKey,
      companyId: null,
    },
    orderBy: { updatedAt: 'desc' },
  });

  if (globalScoped) {
    return globalScoped.value === 'true';
  }

  return fallback;
};
