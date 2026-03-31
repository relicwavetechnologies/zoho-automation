import { prisma } from '../../utils/prisma';

export class ToolActionPermissionRepository {
  async getForCompany(companyId: string) {
    return prisma.toolActionPermission.findMany({ where: { companyId } });
  }

  async upsert(
    companyId: string,
    toolId: string,
    role: string,
    actionGroup: string,
    enabled: boolean,
    updatedBy?: string,
  ) {
    return prisma.toolActionPermission.upsert({
      where: {
        companyId_toolId_role_actionGroup: {
          companyId,
          toolId,
          role,
          actionGroup,
        },
      },
      create: {
        companyId,
        toolId,
        role,
        actionGroup,
        enabled,
        updatedBy,
      },
      update: {
        enabled,
        updatedBy,
      },
    });
  }
}

export const toolActionPermissionRepository = new ToolActionPermissionRepository();
