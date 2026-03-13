import { prisma } from '../../../utils/prisma';

type UpsertLarkOperationalConfigInput = {
  companyId: string;
  createdBy: string;
  defaultBaseAppToken?: string;
  defaultBaseTableId?: string;
  defaultBaseViewId?: string;
  defaultTasklistId?: string;
  defaultCalendarId?: string;
  defaultApprovalCode?: string;
};

export type LarkOperationalConfig = {
  companyId: string;
  defaultBaseAppToken?: string;
  defaultBaseTableId?: string;
  defaultBaseViewId?: string;
  defaultTasklistId?: string;
  defaultCalendarId?: string;
  defaultApprovalCode?: string;
  updatedAt: Date;
};

const normalize = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

class LarkOperationalConfigRepository {
  async upsert(input: UpsertLarkOperationalConfigInput) {
    return prisma.larkOperationalConfig.upsert({
      where: { companyId: input.companyId },
      create: {
        companyId: input.companyId,
        createdBy: input.createdBy,
        defaultBaseAppToken: normalize(input.defaultBaseAppToken),
        defaultBaseTableId: normalize(input.defaultBaseTableId),
        defaultBaseViewId: normalize(input.defaultBaseViewId),
        defaultTasklistId: normalize(input.defaultTasklistId),
        defaultCalendarId: normalize(input.defaultCalendarId),
        defaultApprovalCode: normalize(input.defaultApprovalCode),
      },
      update: {
        defaultBaseAppToken: normalize(input.defaultBaseAppToken),
        defaultBaseTableId: normalize(input.defaultBaseTableId),
        defaultBaseViewId: normalize(input.defaultBaseViewId),
        defaultTasklistId: normalize(input.defaultTasklistId),
        defaultCalendarId: normalize(input.defaultCalendarId),
        defaultApprovalCode: normalize(input.defaultApprovalCode),
      },
    });
  }

  async findByCompanyId(companyId: string): Promise<LarkOperationalConfig | null> {
    const row = await prisma.larkOperationalConfig.findUnique({
      where: { companyId },
    });
    if (!row) {
      return null;
    }

    return {
      companyId: row.companyId,
      defaultBaseAppToken: row.defaultBaseAppToken ?? undefined,
      defaultBaseTableId: row.defaultBaseTableId ?? undefined,
      defaultBaseViewId: row.defaultBaseViewId ?? undefined,
      defaultTasklistId: row.defaultTasklistId ?? undefined,
      defaultCalendarId: row.defaultCalendarId ?? undefined,
      defaultApprovalCode: row.defaultApprovalCode ?? undefined,
      updatedAt: row.updatedAt,
    };
  }
}

export const larkOperationalConfigRepository = new LarkOperationalConfigRepository();
