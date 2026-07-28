import { Worker, type Job } from 'bullmq';
import type { PermissionService } from '../permissions/permission.service';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { CloudinaryAdapter } from '../../infrastructure/cloudinary/cloudinary.adapter';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { Logger } from '../../shared/logger';
import { systemClock } from '../../shared/clock';
import {
  asCompanyId,
  asDepartmentId,
  asToolId,
  asUserId,
} from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { buildFinalCard } from '../../infrastructure/channels/lark/lark-card.builder';
import { isUnrecoverableJobError } from '../../shared/queue-retry';
import {
  AIRTABLE_PRODUCTS,
  airtableOperationFor,
  airtableScopeGroupsFor,
} from './airtable-mcp-manifest';
import {
  exportAirtableRecords,
  type ResolveAirtableMcpConnection,
} from '../orchestration/tools/families/airtable-mcp.tool';
import {
  airtableExportJobId,
  resolveAirtableExportQueueName,
  type AirtableExportCompletion,
  type AirtableExportJobPayload,
} from './airtable-export.queue';

export interface AirtableExportWorkerDeps {
  readonly redisUrl: string;
  readonly queueName?: string;
  readonly getConnection: ResolveAirtableMcpConnection;
  readonly identityRepo: Pick<ChannelIdentityRepoPort, 'resolveByUserId'>;
  readonly permissions: PermissionService;
  readonly cloudinary: CloudinaryAdapter;
  readonly larkAdapter: Pick<LarkChannelAdapter, 'sendToChatId'>;
  readonly logger: Logger;
  readonly csvLinkTtl: number;
  readonly concurrency?: number;
}

export type AirtableExportWorkerJob = Pick<
  Job<AirtableExportJobPayload>,
  'id' | 'data' | 'attemptsMade' | 'opts' | 'updateData'
>;

export class AirtableExportWorker {
  private worker?: Worker<AirtableExportJobPayload>;
  private readonly log: Logger;

  constructor(private readonly deps: AirtableExportWorkerDeps) {
    this.log = deps.logger.child({ service: 'airtable-export-worker' });
  }

  start(): void {
    const queueName = resolveAirtableExportQueueName(this.deps.queueName);
    const concurrency = this.deps.concurrency ?? 1;
    this.worker = new Worker<AirtableExportJobPayload>(
      queueName,
      job => this.processJob(job),
      {
        connection: { url: this.deps.redisUrl },
        concurrency,
      },
    );
    this.worker.on('completed', job => {
      this.log.info('airtable.export.worker.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, error) => {
      this.log.error('airtable.export.worker.failed', {
        jobId: job?.id,
        error: String(error),
      });
    });
    this.log.info('airtable.export.worker.started', { queueName, concurrency });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }

  async processJob(job: AirtableExportWorkerJob): Promise<void> {
    try {
      const completion = job.data.completedExport ?? await this.runExport(job.data);
      if (!job.data.completedExport) {
        await job.updateData({ ...job.data, completedExport: completion });
      }
      await this.deliverCompletion(job, completion);
    } catch (error) {
      const isFinalAttempt = isUnrecoverableJobError(error)
        || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) await this.deliverFailure(job, error);
      throw error;
    }
  }

  private async runExport(payload: AirtableExportJobPayload): Promise<AirtableExportCompletion> {
    const identityResult = await this.deps.identityRepo.resolveByUserId(payload.userId, payload.companyId);
    if (!identityResult.ok) throw new Error(`Could not re-check Airtable export identity: ${identityResult.error.message}`);
    if (!identityResult.value) throw new Error('Airtable export requester no longer has active company access');
    const identity = identityResult.value;

    const permission = await this.deps.permissions.resolve({
      companyId: asCompanyId(payload.companyId),
      userId: asUserId(payload.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      ...(payload.departmentId ? { departmentId: asDepartmentId(payload.departmentId) } : {}),
      channel: 'lark',
    });
    if (!permission.ok) throw new Error(`Airtable export permission check failed: ${permission.error.message}`);
    if (!permission.value.allowedActionsByTool.get(asToolId(payload.toolId))?.has('read')) {
      throw new Error('Airtable record read permission was revoked before the export started');
    }

    const product = AIRTABLE_PRODUCTS.find(candidate => candidate.toolId === payload.toolId);
    const operation = product && airtableOperationFor(product.toolId, payload.nativeTool);
    if (!product || !operation || operation.action !== 'read') {
      throw new Error('Queued Airtable export operation is not an approved record read');
    }

    const resolution = await this.deps.getConnection({
      companyId: payload.companyId,
      userId: payload.userId,
      connectionId: payload.connectionId,
      minimumAccess: 'read_only',
      requiredScopeGroups: airtableScopeGroupsFor(product, 'read'),
    });
    if (resolution.status !== 'resolved') {
      throw new Error('Airtable connection is no longer available or shared for this export');
    }

    this.log.info('airtable.export.worker.processing', {
      companyId: payload.companyId,
      jobRequestId: payload.requestId,
      nativeTool: payload.nativeTool,
    });
    const exported = await exportAirtableRecords({
      args: {
        connectionId: payload.connectionId,
        op: 'call',
        nativeTool: payload.nativeTool,
        input: payload.input,
        exportAll: true,
      },
      ctx: {
        runContext: {
          companyId: asCompanyId(payload.companyId),
          userId: asUserId(payload.userId),
          companyRole: asCompanyRoleSlug(identity.aiRole),
          ...(payload.departmentId ? { departmentId: asDepartmentId(payload.departmentId) } : {}),
          channel: 'lark',
          chatId: payload.chatId,
          requestId: payload.requestId,
          ...(payload.traceId ? { traceId: payload.traceId } : {}),
        },
        perm: permission.value,
        correlationId: payload.traceId ?? payload.requestId,
        logger: this.log,
        clock: systemClock,
      },
      client: resolution.connection.client,
      toolId: product.toolId,
      cloudinary: this.deps.cloudinary,
      csvLinkTtl: this.deps.csvLinkTtl,
    });
    if (!exported.ok) throw exported.error;
    if (!exported.value.success) throw new Error(exported.value.message ?? 'Airtable CSV export failed');

    return {
      success: true,
      message: exported.value.message ?? 'Airtable export completed',
      ...(exported.value.csvLink ? { csvLink: exported.value.csvLink } : {}),
      ...(exported.value.csvPublicId ? { csvPublicId: exported.value.csvPublicId } : {}),
      ...(exported.value.csvExpiresAt ? { csvExpiresAt: exported.value.csvExpiresAt } : {}),
      totalFetched: exported.value.totalFetched ?? 0,
      sourceTruncated: exported.value.sourceTruncated ?? false,
    };
  }

  private async deliverCompletion(
    job: AirtableExportWorkerJob,
    completion: AirtableExportCompletion,
  ): Promise<void> {
    const noCsvCreated = completion.totalFetched === 0 && !completion.csvLink;
    const linkLine = completion.csvLink
      ? `\n\n[Download CSV](${completion.csvLink})`
      : '';
    const expiryLine = completion.csvExpiresAt
      ? `\n- Link expires: ${completion.csvExpiresAt}`
      : '';
    const truncationWarning = completion.sourceTruncated
      ? '\n\n⚠️ The export reached its safety ceiling, so additional Airtable records may exist.'
      : '';
    const card = buildFinalCard({
      markdown: noCsvCreated
        ? `# Airtable export complete\n${completion.message}`
        : `# Airtable export ready\nExported ${completion.totalFetched} record${completion.totalFetched === 1 ? '' : 's'}.${linkLine}${expiryLine}${truncationWarning}`,
    });
    const sent = await this.deps.larkAdapter.sendToChatId(
      job.data.chatId,
      card,
      undefined,
      deliveryKey('atxd', job),
    );
    if (!sent.ok) throw sent.error;
  }

  private async deliverFailure(job: AirtableExportWorkerJob, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const card = buildFinalCard({
      markdown: `# Airtable export failed\nI could not finish the CSV export after retrying.\n\n${reason.slice(0, 300)}`,
    });
    const sent = await this.deps.larkAdapter.sendToChatId(
      job.data.chatId,
      card,
      undefined,
      deliveryKey('atxf', job),
    );
    if (!sent.ok) {
      this.log.warn('airtable.export.failure_delivery_failed', {
        jobId: job.id,
        error: sent.error.message,
      });
    }
  }
}

function deliveryKey(prefix: string, job: AirtableExportWorkerJob): string {
  const id = String(job.id ?? airtableExportJobId(job.data));
  return `${prefix}_${id}`.slice(0, 50);
}
