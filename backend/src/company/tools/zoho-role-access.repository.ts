import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';

const isMissingZohoRoleAccessTable = (error: unknown): boolean =>
  Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'P2021',
  );

export class ZohoRoleAccessRepository {
  async getForCompany(companyId: string) {
    try {
      return await prisma.zohoRoleAccessPolicy.findMany({
        where: { companyId },
        orderBy: [{ role: 'asc' }],
      });
    } catch (error) {
      if (isMissingZohoRoleAccessTable(error)) {
        logger.warn('zoho.role_access.table_missing.read_fallback', {
          companyId,
          reason: 'ZohoRoleAccessPolicy table missing; defaulting all roles to email-scoped access',
        });
        return [];
      }
      throw error;
    }
  }

  async upsert(
    companyId: string,
    role: string,
    companyScopedRead: boolean,
    updatedBy?: string,
  ) {
    try {
      return await prisma.zohoRoleAccessPolicy.upsert({
        where: { companyId_role: { companyId, role } },
        create: { companyId, role, companyScopedRead, updatedBy },
        update: { companyScopedRead, updatedBy },
      });
    } catch (error) {
      if (isMissingZohoRoleAccessTable(error)) {
        logger.error('zoho.role_access.table_missing.write_blocked', {
          companyId,
          role,
          reason: 'ZohoRoleAccessPolicy table missing; apply the Prisma schema change before updating role access',
        });
        throw new Error('Zoho role access storage is not initialized yet. Apply the latest database schema and try again.');
      }
      throw error;
    }
  }
}

export const zohoRoleAccessRepository = new ZohoRoleAccessRepository();
