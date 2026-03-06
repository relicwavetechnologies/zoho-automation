import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import config from '../../config';
import { IngestionJobDTO, ZohoConnectionDTO } from '../../company/contracts';
import { zohoConnectionAdapter } from '../../company/integrations/zoho';
import { ZohoIntegrationError } from '../../company/integrations/zoho/zoho.errors';
import { mcpHttpClient } from '../../company/integrations/zoho/mcp-http.client';
import { resolveZohoProvider } from '../../company/integrations/zoho/zoho-provider.resolver';
import { encryptZohoSecret } from '../../company/integrations/zoho/zoho-token.crypto';
import { qdrantAdapter } from '../../company/integrations/vector';
import { zohoSyncProducer } from '../../company/queue/producer';
import { runZohoDeltaSyncWorker, runZohoHistoricalSyncWorker } from '../../company/queue/workers';
import { logger } from '../../utils/logger';
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

type PersistedZohoConnection = Awaited<
  ReturnType<CompanyOnboardingRepository['upsertZohoConnection']>
>;

export class CompanyOnboardingService extends BaseService {
  constructor(
    private readonly repository: CompanyOnboardingRepository = companyOnboardingRepository,
  ) {
    super();
  }

  async connectZoho(payload: ZohoConnectDto): Promise<CompanyOnboardingConnectResult> {
    const companyId = await this.resolveCompanyId(payload.companyId, payload.companyName);
    const connection = payload.mode === 'mcp'
      ? await this.connectViaMcp(companyId, payload)
      : await this.connectViaRest(companyId, payload);

    const queued = await zohoSyncProducer.enqueueInitialHistoricalSync({
      companyId,
      connectionId: connection.id,
    });

    // Always wake worker so an already-queued job is not left stale.
    void runZohoHistoricalSyncWorker(companyId);

    return {
      companyId,
      environment: connection.environment,
      connection: this.toConnectionDto(connection),
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
      qdrantAdapter.countByCompany(companyId).catch(() => 0),
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
    const [connection, historicalJob, vectorHealth, indexedCount] = await Promise.all([
      this.repository.findLatestConnectionForCompany(companyId),
      this.repository.findLatestHistoricalJob(companyId),
      qdrantAdapter.health(),
      qdrantAdapter.countByCompany(companyId).catch(() => 0),
    ]);

    return {
      companyId,
      connection: connection ? this.toConnectionDto(connection) : null,
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
      vectorIndex: {
        backend: vectorHealth.backend,
        collection: vectorHealth.collection,
        indexedCount,
        healthy: vectorHealth.ok,
      },
    };
  }

  async triggerHistoricalSync(companyId: string, trigger = 'admin_manual_resync') {
    const connection = await this.repository.findLatestConnectionForCompany(companyId);
    if (!connection) {
      throw new HttpException(404, 'No active Zoho connection found for company');
    }

    if (connection.status !== 'CONNECTED') {
      throw new HttpException(409, 'Zoho connection is not active. Connect Zoho before starting sync.');
    }

    const queued = await zohoSyncProducer.enqueueInitialHistoricalSync({
      companyId,
      connectionId: connection.id,
      trigger,
    });

    // Always wake worker so manual retry can recover queued/stale jobs.
    void runZohoHistoricalSyncWorker(companyId);

    return {
      companyId,
      connectionId: connection.id,
      sync: {
        status: queued.enqueued ? 'queued' : 'already_queued',
        jobId: queued.jobId,
      },
      vectorPolicy: 'safe_upsert_preserve_existing',
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

  async getProviderStatus(companyId: string) {
    const connection = await this.repository.findLatestConnectionForCompany(companyId);
    if (!connection) {
      throw new HttpException(404, 'No active Zoho connection found for company');
    }

    const resolved = await resolveZohoProvider({
      companyId,
      environment: connection.environment,
    });
    const context = {
      companyId,
      connectionId: resolved.connectionId,
      environment: resolved.environment,
    };
    const [health, capabilities] = await Promise.all([
      resolved.adapter.health(context),
      resolved.adapter.discoverCapabilities(context).catch(() => []),
    ]);

    return {
      companyId,
      providerMode: resolved.providerMode,
      environment: resolved.environment,
      health,
      capabilities,
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

  private async connectViaRest(
    companyId: string,
    payload: Extract<ZohoConnectDto, { mode: 'rest' }>,
  ): Promise<PersistedZohoConnection> {
    let connected;
    try {
      connected = await zohoConnectionAdapter.connect(
        {
          authorizationCode: payload.authorizationCode,
          scopes: payload.scopes,
          environment: payload.environment,
        },
        companyId,
      );
    } catch (error) {
      const isReplayLikeInvalidCode =
        error instanceof ZohoIntegrationError
        && error.code === 'auth_failed'
        && /invalid_code/i.test(error.message);

      if (!isReplayLikeInvalidCode) {
        throw error;
      }

      const existing = await this.repository.findLatestConnectionForCompany(companyId);
      const recentlyConnected =
        existing
        && existing.environment === payload.environment
        && Date.now() - existing.connectedAt.getTime() <= 10 * 60 * 1000;

      if (!recentlyConnected) {
        throw error;
      }

      logger.warn('zoho.oauth.exchange.duplicate_code_ignored', {
        companyId,
        environment: payload.environment,
        connectionId: existing.id,
      });
      return existing;
    }

    return this.repository.upsertZohoConnection({
      companyId,
      environment: payload.environment,
      providerMode: 'rest',
      status: connected.status,
      connectedAt: new Date(connected.connectedAt),
      scopes: connected.scopes,
      accessTokenEncrypted: connected.tokenState.accessTokenEncrypted,
      refreshTokenEncrypted: connected.tokenState.refreshTokenEncrypted ?? null,
      tokenCipherVersion: connected.tokenState.tokenCipherVersion,
      accessTokenExpiresAt: new Date(connected.tokenState.accessTokenExpiresAt),
      refreshTokenExpiresAt: connected.tokenState.refreshTokenExpiresAt
        ? new Date(connected.tokenState.refreshTokenExpiresAt)
        : null,
      tokenMetadata: connected.tokenState.tokenMetadata ?? null,
      mcpBaseUrl: null,
      mcpApiKeyEncrypted: null,
      mcpWorkspaceKey: null,
      mcpAllowedTools: [],
      mcpCapabilities: null,
      mcpLastHealthStatus: null,
    });
  }

  private async connectViaMcp(
    companyId: string,
    payload: Extract<ZohoConnectDto, { mode: 'mcp' }>,
  ): Promise<PersistedZohoConnection> {
    if (!config.ZOHO_MCP_ENABLED) {
      throw new HttpException(400, 'MCP provider mode is disabled for this environment');
    }

    try {
      const discoveredTools = await mcpHttpClient.listTools({
        baseUrl: payload.mcpBaseUrl,
        apiKey: payload.mcpApiKey,
        workspaceKey: payload.mcpWorkspaceKey,
      });
      const allowedTools = [...new Set(payload.allowedTools.map((tool) => tool.trim()).filter(Boolean))];
      const capabilities = [...new Set([...allowedTools, ...discoveredTools])];
      const encryptedMcpApiKey = encryptZohoSecret(
        payload.mcpApiKey,
        config.MCP_SECRET_ENCRYPTION_KEY || undefined,
      ).cipherText;

      logger.success('mcp.connect.success', {
        companyId,
        environment: payload.environment,
        discoveredTools: discoveredTools.length,
        allowedTools: allowedTools.length,
      });

      return this.repository.upsertZohoConnection({
        companyId,
        environment: payload.environment,
        providerMode: 'mcp',
        status: 'CONNECTED',
        connectedAt: new Date(),
        scopes: payload.scopes,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenCipherVersion: 1,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        tokenMetadata: {
          connectionMode: 'mcp',
        },
        mcpBaseUrl: payload.mcpBaseUrl,
        mcpApiKeyEncrypted: encryptedMcpApiKey,
        mcpWorkspaceKey: payload.mcpWorkspaceKey ?? null,
        mcpAllowedTools: allowedTools,
        mcpCapabilities: {
          tools: capabilities,
        },
        mcpLastHealthStatus: 'healthy',
      });
    } catch (error) {
      logger.error('mcp.connect.failed', {
        companyId,
        environment: payload.environment,
        reason: error instanceof Error ? error.message : 'unknown_error',
        error,
      });
      if (error instanceof HttpException || error instanceof ZohoIntegrationError) {
        throw error;
      }
      throw new ZohoIntegrationError({
        message: error instanceof Error ? error.message : 'MCP connection failed',
        code: 'mcp_unavailable',
        retriable: true,
      });
    }
  }

  private toConnectionDto(connection: PersistedZohoConnection): ZohoConnectionDTO {
    const now = Date.now();
    const accessTokenExpiresAt = connection.accessTokenExpiresAt?.toISOString();

    const tokenStatus: ZohoConnectionDTO['tokenHealth'] =
      connection.providerMode === 'mcp'
        ? undefined
        : {
            status: connection.tokenFailureCode
              ? 'failed'
              : connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() <= now
                ? 'expired'
                : connection.accessTokenExpiresAt &&
                    connection.accessTokenExpiresAt.getTime() - now <= 5 * 60 * 1000
                  ? 'expiring'
                  : connection.accessTokenExpiresAt
                    ? 'healthy'
                    : 'unknown',
            accessTokenExpiresAt,
            lastRefreshAt: connection.lastTokenRefreshAt?.toISOString(),
            failureCode: connection.tokenFailureCode ?? undefined,
          };

    return {
      companyId: connection.companyId,
      status: connection.status as ZohoConnectionDTO['status'],
      connectedAt: connection.connectedAt.toISOString(),
      scopes: connection.scopes,
      lastSyncAt: connection.lastSyncAt?.toISOString(),
      providerMode: connection.providerMode as ZohoConnectionDTO['providerMode'],
      providerHealth:
        connection.providerMode === 'mcp'
          ? ((connection.mcpLastHealthStatus as ZohoConnectionDTO['providerHealth']) ?? 'healthy')
          : undefined,
      capabilities:
        connection.providerMode === 'mcp'
          ? this.readMcpCapabilities(connection.mcpCapabilities)
          : undefined,
      tokenHealth: tokenStatus,
    };
  }

  private readMcpCapabilities(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
    }
    if (!raw || typeof raw !== 'object') {
      return [];
    }

    const tools = (raw as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }

    return tools
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
  }
}

export const companyOnboardingService = new CompanyOnboardingService();
