import type { Prisma } from '../../generated/prisma';

import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class AuditRepository extends BaseRepository {
  createLog(input: {
    actorId: string;
    companyId?: string;
    action: string;
    outcome: 'success' | 'failure';
    metadata?: Record<string, unknown>;
  }) {
    return prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        companyId: input.companyId,
        action: input.action,
        outcome: input.outcome,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  queryLogs(input: {
    companyId?: string;
    actorId?: string;
    action?: string;
    outcome?: 'success' | 'failure';
    limit: number;
  }) {
    return prisma.auditLog.findMany({
      where: {
        ...(input.companyId ? { companyId: input.companyId } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: input.limit,
    });
  }
}

export const auditRepository = new AuditRepository();
