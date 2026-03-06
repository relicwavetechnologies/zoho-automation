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
    providerMode?: 'rest' | 'mcp';
    status: string;
    connectedAt: Date;
    scopes: string[];
    accessTokenEncrypted?: string | null;
    refreshTokenEncrypted?: string | null;
    tokenCipherVersion?: number;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    tokenMetadata?: Record<string, unknown> | null;
    mcpBaseUrl?: string | null;
    mcpApiKeyEncrypted?: string | null;
    mcpWorkspaceKey?: string | null;
    mcpAllowedTools?: string[];
    mcpCapabilities?: Record<string, unknown> | null;
    mcpLastHealthStatus?: string | null;
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
        providerMode: input.providerMode ?? 'rest',
        status: input.status,
        connectedAt: input.connectedAt,
        scopes: input.scopes,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        tokenCipherVersion: input.tokenCipherVersion ?? 1,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
        tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
        mcpBaseUrl: input.mcpBaseUrl,
        mcpApiKeyEncrypted: input.mcpApiKeyEncrypted,
        mcpWorkspaceKey: input.mcpWorkspaceKey,
        mcpAllowedTools: input.mcpAllowedTools ?? [],
        mcpCapabilities: input.mcpCapabilities as Prisma.InputJsonValue | undefined,
        mcpLastHealthAt: input.mcpLastHealthStatus ? new Date() : null,
        mcpLastHealthStatus: input.mcpLastHealthStatus,
        tokenFailureCode: null,
        lastTokenRefreshAt: new Date(),
      },
      update: {
        providerMode: input.providerMode ?? 'rest',
        status: input.status,
        connectedAt: input.connectedAt,
        scopes: input.scopes,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        tokenCipherVersion: input.tokenCipherVersion ?? 1,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
        tokenMetadata: input.tokenMetadata as Prisma.InputJsonValue | undefined,
        mcpBaseUrl: input.mcpBaseUrl,
        mcpApiKeyEncrypted: input.mcpApiKeyEncrypted,
        mcpWorkspaceKey: input.mcpWorkspaceKey,
        mcpAllowedTools: input.mcpAllowedTools ?? [],
        mcpCapabilities: input.mcpCapabilities as Prisma.InputJsonValue | undefined,
        mcpLastHealthAt: input.mcpLastHealthStatus ? new Date() : null,
        mcpLastHealthStatus: input.mcpLastHealthStatus,
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
