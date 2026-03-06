import { prisma } from '../../utils/prisma';

export class ToolPermissionRepository {
  async getForCompany(companyId: string) {
    return prisma.toolPermission.findMany({ where: { companyId } });
  }

  async upsert(
    companyId: string,
    toolId: string,
    role: string,
    enabled: boolean,
    updatedBy?: string,
  ) {
    return prisma.toolPermission.upsert({
      where: { companyId_toolId_role: { companyId, toolId, role } },
      create: { companyId, toolId, role, enabled, updatedBy },
      update: { enabled, updatedBy },
    });
  }
}

export const toolPermissionRepository = new ToolPermissionRepository();
