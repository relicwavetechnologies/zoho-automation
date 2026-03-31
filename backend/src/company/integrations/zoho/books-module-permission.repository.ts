import { prisma } from '../../../utils/prisma';

export class BooksModulePermissionRepository {
  async getForRole(companyId: string, departmentRoleId: string) {
    return prisma.booksModulePermission.findMany({
      where: { companyId, departmentRoleId },
    });
  }

  async getForCompany(companyId: string) {
    return prisma.booksModulePermission.findMany({
      where: { companyId },
    });
  }

  async upsert(
    companyId: string,
    departmentRoleId: string,
    module: string,
    enabled: boolean,
    scopeOverride: string | null | undefined,
    updatedBy?: string,
  ) {
    return prisma.booksModulePermission.upsert({
      where: {
        companyId_departmentRoleId_module: {
          companyId,
          departmentRoleId,
          module,
        },
      },
      create: {
        companyId,
        departmentRoleId,
        module,
        enabled,
        scopeOverride: scopeOverride ?? null,
        updatedBy,
      },
      update: {
        enabled,
        scopeOverride: scopeOverride ?? null,
        updatedBy,
      },
    });
  }
}

export const booksModulePermissionRepository = new BooksModulePermissionRepository();
