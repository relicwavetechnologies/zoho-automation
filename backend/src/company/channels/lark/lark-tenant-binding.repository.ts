import { prisma } from '../../../utils/prisma';

type UpsertLarkTenantBindingInput = {
  companyId: string;
  larkTenantKey: string;
  createdBy: string;
  isActive: boolean;
};

class LarkTenantBindingRepository {
  async upsert(input: UpsertLarkTenantBindingInput) {
    const normalizedKey = input.larkTenantKey.trim();
    return prisma.larkTenantBinding.upsert({
      where: {
        larkTenantKey: normalizedKey,
      },
      create: {
        companyId: input.companyId,
        larkTenantKey: normalizedKey,
        createdBy: input.createdBy,
        isActive: input.isActive,
      },
      update: {
        companyId: input.companyId,
        isActive: input.isActive,
      },
    });
  }

  async resolveCompanyId(larkTenantKey: string): Promise<string | null> {
    const binding = await prisma.larkTenantBinding.findUnique({
      where: {
        larkTenantKey: larkTenantKey.trim(),
      },
      select: {
        companyId: true,
        isActive: true,
      },
    });

    if (!binding || !binding.isActive) {
      return null;
    }

    return binding.companyId;
  }

  async listByCompany(companyId: string) {
    return prisma.larkTenantBinding.findMany({
      where: {
        companyId,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }
}

export const larkTenantBindingRepository = new LarkTenantBindingRepository();
