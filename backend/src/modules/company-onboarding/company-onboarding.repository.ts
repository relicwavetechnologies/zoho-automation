import type { Company, Prisma, ZohoConnection } from '../../generated/prisma';

import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class CompanyOnboardingRepository extends BaseRepository {
  findCompanyById(companyId: string): Promise<Company | null> {
    return prisma.company.findUnique({
      where: { id: companyId },
    });
  }

  createCompany(name: string): Promise<Company> {
    return prisma.company.create({
      data: { name },
    });
  }

  upsertZohoConnection(input: {
    companyId: string;
    environment: string;
    status: string;
    connectedAt: Date;
    scopes: string[];
    accessTokenEncrypted: string;
    refreshTokenEncrypted?: string;
    tokenCipherVersion: number;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt?: Date;
    tokenMetadata?: Record<string, unknown>;
  }): Promise<ZohoConnection> {
    return prisma.zohoConnection.upsert({
      where: {
        companyId_environment: {
          companyId: input.companyId,
          environment: input.environment,
        },
      },
      create: {
        companyId: input.companyId,
        environment: input.environment,
        status: input.status,
        connectedAt: input.connectedAt,
        scopes: input.scopes,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        tokenCipherVersion: input.tokenCipherVersion,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
        tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
        tokenFailureCode: null,
        lastTokenRefreshAt: new Date(),
      },
      update: {
        status: input.status,
        connectedAt: input.connectedAt,
        scopes: input.scopes,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        tokenCipherVersion: input.tokenCipherVersion,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
        tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
        tokenFailureCode: null,
        lastTokenRefreshAt: new Date(),
      },
    });
  }

  findSyncJobById(jobId: string) {
    return prisma.zohoSyncJob.findUnique({
      where: { id: jobId },
      include: {
        events: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  findLatestConnectionForCompany(companyId: string) {
    return prisma.zohoConnection.findFirst({
      where: {
        companyId,
        status: 'CONNECTED',
      },
      orderBy: {
        connectedAt: 'desc',
      },
    });
  }

  findLifecycleSnapshot(companyId: string) {
    return prisma.company.findUnique({
      where: {
        id: companyId,
      },
      include: {
        zohoConnections: {
          orderBy: {
            connectedAt: 'desc',
          },
          take: 1,
        },
        zohoSyncJobs: {
          orderBy: {
            queuedAt: 'desc',
          },
          take: 20,
        },
      },
    });
  }

  countVectorDocuments(companyId: string): Promise<number> {
    return prisma.vectorDocument.count({
      where: {
        companyId,
      },
    });
  }

  countPendingDeltaEvents(companyId: string): Promise<number> {
    return prisma.zohoDeltaEvent.count({
      where: {
        companyId,
        status: {
          in: ['queued', 'retry_pending'],
        },
      },
    });
  }

  findLatestHistoricalJob(companyId: string) {
    return prisma.zohoSyncJob.findFirst({
      where: {
        companyId,
        jobType: 'historical',
      },
      orderBy: {
        queuedAt: 'desc',
      },
    });
  }

  disconnectCompanyConnections(companyId: string) {
    return prisma.zohoConnection.updateMany({
      where: {
        companyId,
        status: 'CONNECTED',
      },
      data: {
        status: 'DISCONNECTED',
      },
    });
  }
}

export const companyOnboardingRepository = new CompanyOnboardingRepository();
