import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { IngestionJobDTO, ZohoConnectionDTO } from '../../company/contracts';
import { zohoConnectionAdapter } from '../../company/integrations/zoho';
import { zohoSyncProducer } from '../../company/queue/producer';
import { runZohoDeltaSyncWorker, runZohoHistoricalSyncWorker } from '../../company/queue/workers';
import {
  CompanyOnboardingRepository,
  companyOnboardingRepository,
} from './company-onboarding.repository';
import { CompanyOnboardingConnectResult } from './company-onboarding.model';
import { DeltaSyncEnqueueResult } from './company-onboarding.model';
import { HistoricalSyncStatusResult } from './company-onboarding.model';
import { OnboardingLifecycleValidationResult } from './company-onboarding.model';
import { DeltaSyncEventDto } from './dto/delta-sync-event.dto';
import { ZohoConnectDto } from './dto/zoho-connect.dto';

export class CompanyOnboardingService extends BaseService {
  constructor(
    private readonly repository: CompanyOnboardingRepository = companyOnboardingRepository,
  ) {
    super();
  }

  async connectZoho(payload: ZohoConnectDto): Promise<CompanyOnboardingConnectResult> {
    const companyId = await this.resolveCompanyId(payload.companyId, payload.companyName);

    const adapterResult = await zohoConnectionAdapter.connect(
      {
        authorizationCode: payload.authorizationCode,
        scopes: payload.scopes,
      },
      companyId,
    );

    if (adapterResult.status !== 'CONNECTED') {
      throw new HttpException(400, 'Zoho connection failed');
    }

    const connection = await this.repository.upsertZohoConnection({
      companyId,
      environment: payload.environment,
      status: adapterResult.status,
      connectedAt: new Date(adapterResult.connectedAt),
      scopes: adapterResult.scopes,
    });

    const queued = await zohoSyncProducer.enqueueInitialHistoricalSync({
      companyId,
      connectionId: connection.id,
    });

    if (queued.enqueued) {
      void runZohoHistoricalSyncWorker(companyId);
    }

    const connectionDto: ZohoConnectionDTO = {
      companyId,
      status: connection.status as ZohoConnectionDTO['status'],
      connectedAt: connection.connectedAt.toISOString(),
      scopes: connection.scopes,
      lastSyncAt: connection.lastSyncAt?.toISOString(),
    };

    return {
      companyId,
      environment: connection.environment,
      connection: connectionDto,
      initialSync: {
        status: queued.enqueued ? 'queued' : 'already_queued',
        jobId: queued.jobId,
      },
    };
  }

  async getHistoricalSyncStatus(jobId: string): Promise<HistoricalSyncStatusResult> {
    const job = await this.repository.findSyncJobById(jobId);
    if (!job) {
      throw new HttpException(404, 'Historical sync job not found');
    }

    const ingestionJob: IngestionJobDTO = {
      jobId: job.id,
      companyId: job.companyId,
      source: 'zoho',
      mode: job.jobType === 'delta' ? 'delta' : 'historical_full',
      status: job.status as IngestionJobDTO['status'],
      progressPercent: job.progressPercent,
      checkpoint: job.checkpoint ?? undefined,
      startedAt: job.startedAt?.toISOString(),
      completedAt: job.finishedAt?.toISOString(),
    };

    return {
      job: ingestionJob,
      events: job.events.map((event) => ({
        id: event.id,
        fromStatus: event.fromStatus ?? undefined,
        toStatus: event.toStatus,
        message: event.message ?? undefined,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async handleDeltaSyncEvent(event: DeltaSyncEventDto): Promise<DeltaSyncEnqueueResult> {
    const connection = await this.repository.findLatestConnectionForCompany(event.companyId);
    if (!connection) {
      throw new HttpException(404, 'No active Zoho connection found for company');
    }

    const queued = await zohoSyncProducer.enqueueDeltaSyncEvent({
      companyId: event.companyId,
      connectionId: connection.id,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      operation: event.operation,
      changedAt: event.changedAt,
      eventKey: event.eventKey,
      payload: event.payload,
    });

    if (queued.enqueued) {
      void runZohoDeltaSyncWorker(event.companyId);
    }

    return {
      eventKey: event.eventKey,
      status: queued.eventStatus,
      jobId: queued.jobId,
    };
  }

  async validateOnboardingLifecycle(companyId: string): Promise<OnboardingLifecycleValidationResult> {
    const [snapshot, vectorDocumentCount, deltaPendingCount] = await Promise.all([
      this.repository.findLifecycleSnapshot(companyId),
      this.repository.countVectorDocuments(companyId),
      this.repository.countPendingDeltaEvents(companyId),
    ]);

    if (!snapshot) {
      throw new HttpException(404, 'Company not found');
    }

    const latestHistorical = snapshot.zohoSyncJobs.find((job) => job.jobType === 'historical');
    const latestDelta = snapshot.zohoSyncJobs.find((job) => job.jobType === 'delta');
    const hasConnection = snapshot.zohoConnections.length > 0;

    return {
      companyId,
      hasConnection,
      latestHistoricalStatus: latestHistorical?.status,
      latestDeltaStatus: latestDelta?.status,
      vectorDocumentCount,
      deltaPendingCount,
      checks: {
        onboardingConnected: hasConnection,
        historicalCompleted: latestHistorical?.status === 'completed',
        deltaPipelineHealthy: deltaPendingCount === 0,
        vectorsAvailable: vectorDocumentCount > 0,
      },
    };
  }

  async getCompanyOnboardingStatus(companyId: string) {
    const [connection, historicalJob] = await Promise.all([
      this.repository.findLatestConnectionForCompany(companyId),
      this.repository.findLatestHistoricalJob(companyId),
    ]);

    return {
      companyId,
      connection: connection
        ? {
          status: connection.status,
          connectedAt: connection.connectedAt.toISOString(),
          scopes: connection.scopes,
          lastSyncAt: connection.lastSyncAt?.toISOString(),
        }
        : null,
      historicalSync: historicalJob
        ? {
          jobId: historicalJob.id,
          status: historicalJob.status,
          progressPercent: historicalJob.progressPercent,
          checkpoint: historicalJob.checkpoint ?? undefined,
          queuedAt: historicalJob.queuedAt.toISOString(),
          startedAt: historicalJob.startedAt?.toISOString(),
          finishedAt: historicalJob.finishedAt?.toISOString(),
        }
        : null,
    };
  }

  async disconnectZoho(companyId: string) {
    const result = await this.repository.disconnectCompanyConnections(companyId);
    return {
      companyId,
      disconnected: result.count > 0,
      affectedConnections: result.count,
    };
  }

  private async resolveCompanyId(
    companyId?: string,
    companyName?: string,
  ): Promise<string> {
    if (companyId) {
      const existing = await this.repository.findCompanyById(companyId);
      if (!existing) {
        throw new HttpException(404, 'Company not found');
      }
      return existing.id;
    }

    if (!companyName) {
      throw new HttpException(400, 'companyName is required when companyId is missing');
    }

    const company = await this.repository.createCompany(companyName);
    return company.id;
  }
}

export const companyOnboardingService = new CompanyOnboardingService();
