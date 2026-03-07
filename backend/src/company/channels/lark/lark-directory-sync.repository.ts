import { Prisma } from '../../../generated/prisma';

import { prisma } from '../../../utils/prisma';

type CreateLarkDirectorySyncRunInput = {
  companyId: string;
  trigger: string;
  status: string;
};

type CompleteLarkDirectorySyncRunInput = {
  syncedCount: number;
  adminCount: number;
  memberCount: number;
  diagnostics?: Prisma.InputJsonObject | null;
};

class LarkDirectorySyncRepository {
  createRun(input: CreateLarkDirectorySyncRunInput) {
    return prisma.larkDirectorySyncRun.create({
      data: {
        companyId: input.companyId,
        trigger: input.trigger,
        status: input.status,
        startedAt: new Date(),
      },
    });
  }

  markCompleted(runId: string, input: CompleteLarkDirectorySyncRunInput) {
    return prisma.larkDirectorySyncRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        syncedCount: input.syncedCount,
        adminCount: input.adminCount,
        memberCount: input.memberCount,
        diagnostics: input.diagnostics ?? undefined,
        finishedAt: new Date(),
      },
    });
  }

  markFailed(runId: string, errorMessage: string, diagnostics?: Prisma.InputJsonObject | null) {
    return prisma.larkDirectorySyncRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        errorMessage,
        diagnostics: diagnostics ?? undefined,
        finishedAt: new Date(),
      },
    });
  }

  findLatestRun(companyId: string) {
    return prisma.larkDirectorySyncRun.findFirst({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findRunningRun(companyId: string) {
    return prisma.larkDirectorySyncRun.findFirst({
      where: {
        companyId,
        status: {
          in: ['queued', 'running'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}

export const larkDirectorySyncRepository = new LarkDirectorySyncRepository();
