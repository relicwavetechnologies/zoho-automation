import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class AdminControlsRepository extends BaseRepository {
  listControlStates(companyId?: string) {
    return prisma.adminControlState.findMany({
      where: {
        ...(companyId ? { companyId } : {}),
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
  }

  upsertControlState(input: {
    controlKey: string;
    companyId?: string;
    value: string;
    updatedBy: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.adminControlState.findFirst({
        where: {
          controlKey: input.controlKey,
          companyId: input.companyId,
        },
      });

      if (existing) {
        return tx.adminControlState.update({
          where: { id: existing.id },
          data: {
            value: input.value,
            updatedBy: input.updatedBy,
          },
        });
      }

      return tx.adminControlState.create({
        data: {
          controlKey: input.controlKey,
          companyId: input.companyId,
          value: input.value,
          updatedBy: input.updatedBy,
        },
      });
    });
  }
}

export const adminControlsRepository = new AdminControlsRepository();
