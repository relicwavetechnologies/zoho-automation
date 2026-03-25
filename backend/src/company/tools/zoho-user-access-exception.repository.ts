import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';

const getModel = () =>
  (prisma as unknown as {
    zohoUserAccessException?: {
      findMany: (args: Record<string, unknown>) => Promise<any[]>;
      findFirst: (args: Record<string, unknown>) => Promise<any | null>;
      upsert: (args: Record<string, unknown>) => Promise<any>;
      delete: (args: Record<string, unknown>) => Promise<any>;
    };
  }).zohoUserAccessException;

const buildMissingModelError = (): Error =>
  new Error('Zoho access exception storage is not initialized yet. Apply the latest database schema and try again.');

export class ZohoUserAccessExceptionRepository {
  async listByCompany(companyId: string) {
    const model = getModel();
    if (!model) {
      logger.warn('zoho.access_exception.model_missing.list', { companyId });
      return [];
    }
    return model.findMany({
      where: { companyId },
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  async findActiveByUser(companyId: string, userId: string, now = new Date()) {
    const model = getModel();
    if (!model) {
      logger.warn('zoho.access_exception.model_missing.find', { companyId, userId });
      return null;
    }
    return model.findFirst({
      where: {
        companyId,
        userId,
        bypassRelationScope: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  async findById(id: string) {
    const model = getModel();
    if (!model) {
      logger.warn('zoho.access_exception.model_missing.find_by_id', { id });
      return null;
    }
    return model.findFirst({
      where: { id },
    });
  }

  async upsert(input: {
    companyId: string;
    userId: string;
    bypassRelationScope: boolean;
    reason?: string | null;
    expiresAt?: Date | null;
    actorId: string;
  }) {
    const model = getModel();
    if (!model) {
      logger.error('zoho.access_exception.model_missing.upsert', {
        companyId: input.companyId,
        userId: input.userId,
      });
      throw buildMissingModelError();
    }
    return model.upsert({
      where: {
        companyId_userId: {
          companyId: input.companyId,
          userId: input.userId,
        },
      },
      create: {
        companyId: input.companyId,
        userId: input.userId,
        bypassRelationScope: input.bypassRelationScope,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      },
      update: {
        bypassRelationScope: input.bypassRelationScope,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        updatedBy: input.actorId,
      },
    });
  }

  async delete(id: string) {
    const model = getModel();
    if (!model) {
      logger.error('zoho.access_exception.model_missing.delete', { id });
      throw buildMissingModelError();
    }
    return model.delete({
      where: { id },
    });
  }
}

export const zohoUserAccessExceptionRepository = new ZohoUserAccessExceptionRepository();
