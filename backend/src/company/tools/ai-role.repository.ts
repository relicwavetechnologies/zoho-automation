import { prisma } from '../../utils/prisma';

export type AiRoleRow = {
  id: string;
  companyId: string;
  slug: string;
  displayName: string;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
};

class AiRoleRepository {
  async listByCompany(companyId: string): Promise<AiRoleRow[]> {
    return prisma.aiRoleDefinition.findMany({
      where: { companyId },
      orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async create(companyId: string, slug: string, displayName: string): Promise<AiRoleRow> {
    return prisma.aiRoleDefinition.create({
      data: { companyId, slug, displayName, isBuiltIn: false },
    });
  }

  async update(id: string, companyId: string, displayName: string): Promise<AiRoleRow> {
    return prisma.aiRoleDefinition.update({
      where: { id },
      data: { displayName },
    });
  }

  async delete(id: string, companyId: string): Promise<void> {
    await prisma.aiRoleDefinition.deleteMany({
      where: { id, companyId, isBuiltIn: false },
    });
  }

  async findBySlug(companyId: string, slug: string): Promise<AiRoleRow | null> {
    return prisma.aiRoleDefinition.findUnique({
      where: { companyId_slug: { companyId, slug } },
    });
  }

  async ensureBuiltIns(companyId: string): Promise<void> {
    const builtIns = [
      { slug: 'MEMBER', displayName: 'Member' },
      { slug: 'COMPANY_ADMIN', displayName: 'Company Admin' },
      { slug: 'SUPER_ADMIN', displayName: 'Super Admin' },
    ];
    for (const role of builtIns) {
      await prisma.aiRoleDefinition.upsert({
        where: { companyId_slug: { companyId, slug: role.slug } },
        create: { companyId, slug: role.slug, displayName: role.displayName, isBuiltIn: true },
        update: {},
      });
    }
  }
}

export const aiRoleRepository = new AiRoleRepository();
