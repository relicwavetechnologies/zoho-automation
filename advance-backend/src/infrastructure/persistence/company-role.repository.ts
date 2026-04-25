import type { PrismaClient } from '../../generated/prisma';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';
import { wrapInfra, type InfraError } from '../../shared/errors';

export interface CompanyRoleRow {
  id: string;
  companyId: string;
  slug: string;
  displayName: string;
  isBuiltIn: boolean;
}

export interface CompanyRoleRepoPort {
  listByCompany(companyId: string): Promise<Result<CompanyRoleRow[], InfraError>>;
  getValidSlugs(companyId: string): Promise<Result<string[], InfraError>>;
  ensureBuiltIns(companyId: string): Promise<Result<void, InfraError>>;
  upsertCustom(companyId: string, slug: string, displayName: string): Promise<Result<CompanyRoleRow, InfraError>>;
  delete(companyId: string, slug: string): Promise<Result<void, InfraError>>;
}

export class CompanyRoleRepository implements CompanyRoleRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async listByCompany(companyId: string): Promise<Result<CompanyRoleRow[], InfraError>> {
    try {
      const rows = await this.db.aiRoleDefinition.findMany({
        where: { companyId },
        orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }],
      });
      return ok(rows);
    } catch (e) {
      return err(wrapInfra('prisma', 'listCompanyRoles', e));
    }
  }

  async getValidSlugs(companyId: string): Promise<Result<string[], InfraError>> {
    try {
      const rows = await this.db.aiRoleDefinition.findMany({
        where: { companyId },
        select: { slug: true },
      });
      return ok(rows.map(r => r.slug));
    } catch (e) {
      return err(wrapInfra('prisma', 'getValidSlugs', e));
    }
  }

  async ensureBuiltIns(companyId: string): Promise<Result<void, InfraError>> {
    const builtIns = [
      { slug: 'MEMBER',        displayName: 'Member' },
      { slug: 'COMPANY_ADMIN', displayName: 'Company Admin' },
      { slug: 'SUPER_ADMIN',   displayName: 'Super Admin' },
    ];
    try {
      for (const role of builtIns) {
        await this.db.aiRoleDefinition.upsert({
          where: { companyId_slug: { companyId, slug: role.slug } },
          create: { companyId, slug: role.slug, displayName: role.displayName, isBuiltIn: true },
          update: {},
        });
      }
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'ensureBuiltIns', e));
    }
  }

  async upsertCustom(companyId: string, slug: string, displayName: string): Promise<Result<CompanyRoleRow, InfraError>> {
    try {
      const row = await this.db.aiRoleDefinition.upsert({
        where: { companyId_slug: { companyId, slug } },
        create: { companyId, slug, displayName, isBuiltIn: false },
        update: { displayName },
      });
      return ok(row);
    } catch (e) {
      return err(wrapInfra('prisma', 'upsertCustomRole', e));
    }
  }

  async delete(companyId: string, slug: string): Promise<Result<void, InfraError>> {
    try {
      await this.db.aiRoleDefinition.deleteMany({
        where: { companyId, slug, isBuiltIn: false },
      });
      return ok(undefined);
    } catch (e) {
      return err(wrapInfra('prisma', 'deleteRole', e));
    }
  }
}
