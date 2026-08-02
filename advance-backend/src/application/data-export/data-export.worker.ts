import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { PermissionService } from '../permissions/permission.service';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { Logger } from '../../shared/logger';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import {
  asCompanyId,
  asDepartmentId,
  asToolId,
  asUserId,
} from '../../shared/ids';
import { buildFinalCard } from '../../infrastructure/channels/lark/lark-card.builder';
import { isUnrecoverableJobError } from '../../shared/queue-retry';
import { DataExportTransformSandbox } from './data-export.sandbox';
import {
  dataExportJobId,
  resolveDataExportQueueName,
} from './data-export.queue';
import type {
  DataExportCompletion,
  DataExportJobPayload,
} from './data-export.types';
import {
  DATA_EXPORT_ROW_LIMIT,
  datasetSourceToolId,
} from './data-export.types';
import type {
  DataExportDestinationSink,
  GoogleExportAuth,
} from './data-export.destination';
import type { DatasetSourceRegistry } from './data-export.source-registry';

export interface DataExportWorkerDeps {
  readonly redisUrl: string;
  readonly queueName?: string;
  readonly sources: DatasetSourceRegistry;
  readonly sink: DataExportDestinationSink;
  readonly identityRepo: Pick<ChannelIdentityRepoPort, 'resolveByUserId'>;
  readonly permissions: PermissionService;
  readonly resolveGoogleAuth: (
    companyId: string,
    userId: string,
    target?: DataExportJobPayload['destination']['target'],
  ) => Promise<GoogleExportAuth>;
  readonly larkAdapter: Pick<LarkChannelAdapter, 'sendToChatId' | 'updateMessageById'>;
  readonly logger: Logger;
  readonly concurrency?: number;
  readonly inactivityMs?: number;
  readonly maxRows?: number;
}

export type DataExportWorkerJob = Pick<
  Job<DataExportJobPayload>,
  'id' | 'data' | 'attemptsMade' | 'opts' | 'updateData' | 'updateProgress'
>;

export class DataExportWorker {
  private worker?: Worker<DataExportJobPayload>;
  private readonly log: Logger;

  constructor(private readonly deps: DataExportWorkerDeps) {
    this.log = deps.logger.child({ service: 'data-export-worker' });
  }

  start(): void {
    const queueName = resolveDataExportQueueName(this.deps.queueName);
    const concurrency = this.deps.concurrency ?? 1;
    this.worker = new Worker<DataExportJobPayload>(
      queueName,
      (job) => this.processJob(job),
      { connection: { url: this.deps.redisUrl }, concurrency },
    );
    this.worker.on('completed', (job) => {
      this.log.info('data_export.worker.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, error) => {
      this.log.error('data_export.worker.failed', { jobId: job?.id, error: String(error) });
    });
    this.log.info('data_export.worker.started', { queueName, concurrency });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }

  async processJob(job: DataExportWorkerJob): Promise<void> {
    let payload = job.data;
    let progressMessageId = payload.progressMessageId;
    try {
      if (!progressMessageId) {
        progressMessageId = await this.createProgressTracker(job);
        payload = { ...payload, progressMessageId };
        await job.updateData(payload);
      } else if (!payload.completedExport) {
        await this.initializeProgressTracker(progressMessageId);
      }
      const completion = payload.completedExport
        ?? await this.runExport(job, payload, progressMessageId);
      if (!payload.completedExport) {
        payload = { ...payload, completedExport: completion };
        await job.updateData(payload);
      }
      await this.deliverCompletion(job, completion, progressMessageId);
    } catch (error) {
      const finalAttempt = isUnrecoverableJobError(error)
        || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt && !payload.completedExport) {
        await this.deliverFailure(job, error, progressMessageId);
      }
      throw error;
    }
  }

  private async runExport(
    job: DataExportWorkerJob,
    payload: DataExportJobPayload,
    progressMessageId: string,
  ): Promise<DataExportCompletion> {
    const identityResult = await this.deps.identityRepo.resolveByUserId(payload.userId, payload.companyId);
    if (!identityResult.ok) throw new Error(`Could not re-check export identity: ${identityResult.error.message}`);
    if (!identityResult.value) {
      throw new UnrecoverableError('Export requester no longer has active company access');
    }
    const identity = identityResult.value;
    const readerEmail = normalizedEmail(identity.email);
    if (!readerEmail) {
      throw new UnrecoverableError('Data export requires a verified email for the invoking Lark user');
    }
    const permission = await this.deps.permissions.resolve({
      companyId: asCompanyId(payload.companyId),
      userId: asUserId(payload.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      ...(payload.departmentId ? { departmentId: asDepartmentId(payload.departmentId) } : {}),
      channel: 'lark',
    });
    if (!permission.ok) throw new Error(`Data export permission check failed: ${permission.error.message}`);
    if (!permission.value.allowedActionsByTool.get(asToolId('dataExport'))?.has('create')) {
      throw new UnrecoverableError('Data export permission was revoked before the job started');
    }
    const sourceToolId = datasetSourceToolId(payload.source);
    if (!permission.value.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
      throw new UnrecoverableError(`${sourceToolId} read permission was revoked before the export started`);
    }
    if (
      payload.source.kind === 'zoho_books'
      && permission.value.department?.zohoReadScope === 'personalized'
    ) {
      throw new UnrecoverableError('Complete Zoho exports require full company Zoho read scope');
    }

    const googleAuth = await this.deps.resolveGoogleAuth(
      payload.companyId,
      payload.userId,
      payload.destination.target,
    );
    if (
      'readerDomain' in googleAuth
      && readerEmail.split('@')[1] !== googleAuth.readerDomain.toLowerCase()
    ) {
      throw new UnrecoverableError(
        `Data export can only share with a verified ${googleAuth.readerDomain} invoker`,
      );
    }
    const inactivityMs = this.deps.inactivityMs ?? 10 * 60 * 1_000;
    const abortController = new AbortController();
    let inactivityTimer: NodeJS.Timeout | undefined;
    const touch = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        abortController.abort(new Error('Data export made no progress for the configured inactivity window'));
      }, inactivityMs);
    };
    const adapter = this.deps.sources.resolve(payload.source);
    const sandbox = new DataExportTransformSandbox(payload.transform);
    touch();
    const maxRows = resolvedExportRowLimit(this.deps.maxRows);
    let sourceTruncated = false;
    let inputIndex = 0;
    let outputIndex = 0;
    let pageCount = 0;
    let lastTrackerUpdateAt = 0;
    const updateProgressTracker = this.updateProgressTracker.bind(this);
    const transformedPages = (async function* () {
      for await (const page of adapter.read(payload.source, {
        companyId: payload.companyId,
        userId: payload.userId,
        signal: abortController.signal,
      })) {
        touch();
        sourceTruncated ||= page.sourceTruncated === true;
        const remainingInput = maxRows - inputIndex;
        const inputRows = page.rows.slice(0, remainingInput);
        const transformed = await sandbox.transformPage(inputRows, inputIndex);
        inputIndex += inputRows.length;
        const remainingOutput = maxRows - outputIndex;
        const outputRows = transformed.slice(0, remainingOutput);
        outputIndex += outputRows.length;
        sourceTruncated ||= page.rows.length > inputRows.length
          || transformed.length > outputRows.length
          || (inputIndex >= maxRows && page.hasMore === true);
        pageCount += 1;
        if (pageCount === 1 || pageCount % 10 === 0) {
          const progress = {
            stage: 'reading',
            pagesRead: pageCount,
            rowsRead: inputIndex,
          } as const;
          await job.updateProgress(progress);
          await updateProgressTracker(progressMessageId, progress);
          lastTrackerUpdateAt = Date.now();
        }
        if (outputRows.length > 0) yield outputRows;
        if (inputIndex >= maxRows || outputIndex >= maxRows) break;
      }
      const progress = {
        stage: 'writing',
        pagesRead: pageCount,
        rowsRead: inputIndex,
      } as const;
      await job.updateProgress(progress);
      await updateProgressTracker(progressMessageId, progress);
      lastTrackerUpdateAt = Date.now();
    })();

    this.log.info('data_export.worker.processing', {
      companyId: payload.companyId,
      requestId: payload.requestId,
      source: payload.source.kind,
      destination: payload.destination.format,
      destinationOwner: payload.destination.target?.kind ?? 'legacy_company_google',
    });
    try {
      const completion = await this.deps.sink.write({
        auth: googleAuth,
        readerEmail,
        exportKey: String(job.id ?? dataExportJobId(payload)),
        destination: payload.destination,
        rows: transformedPages,
        sourceTruncated: () => sourceTruncated,
        signal: abortController.signal,
        onProgress: async (progress) => {
          touch();
          await job.updateProgress({
            stage: progress.stage,
            pagesRead: pageCount,
            rowsRead: inputIndex,
            rowsWritten: progress.rowsProcessed,
          });
          if (Date.now() - lastTrackerUpdateAt >= 5_000 || progress.rowsProcessed === inputIndex) {
            await updateProgressTracker(progressMessageId, {
              stage: 'writing',
              pagesRead: pageCount,
              rowsRead: inputIndex,
              rowsWritten: progress.rowsProcessed,
            });
            lastTrackerUpdateAt = Date.now();
          }
        },
      });
      await job.updateProgress({
        stage: 'completed',
        pagesRead: pageCount,
        rowsRead: inputIndex,
        rowsExported: completion.rowCount,
      });
      return completion;
    } catch (error) {
      if (abortController.signal.aborted && abortController.signal.reason instanceof Error) {
        throw abortController.signal.reason;
      }
      throw error;
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      await sandbox.close();
    }
  }

  private async deliverCompletion(
    job: DataExportWorkerJob,
    completion: DataExportCompletion,
    progressMessageId: string,
  ): Promise<void> {
    const warning = completion.sourceTruncated
      ? `\n\n⚠️ Current exports are capped at ${resolvedExportRowLimit(this.deps.maxRows).toLocaleString('en-IN')} rows. Additional source rows were not included.`
      : '';
    const card = buildFinalCard({
      markdown: [
        '# Data export ready',
        `Exported ${completion.rowCount} row${completion.rowCount === 1 ? '' : 's'} to a verified ${completion.artifactType === 'google_sheet' ? 'Google Sheet' : completion.artifactType === 'xlsx' ? 'Excel file in Google Drive' : 'CSV in Google Drive'}.`,
        `[Open export](${completion.artifactUrl})`,
        `Access: ${completion.sharedWith}${warning}`,
      ].join('\n\n'),
    });
    const updated = await this.deps.larkAdapter.updateMessageById(progressMessageId, card);
    if (updated.ok) return;
    throw updated.error;
  }

  private async deliverFailure(
    job: DataExportWorkerJob,
    error: unknown,
    progressMessageId?: string,
  ): Promise<void> {
    this.log.error('data_export.failure_delivered', {
      jobId: job.id,
      error: String(error),
    });
    const card = buildFinalCard({
      markdown: '# Data export could not finish\nDivo could not complete this export. Your source data was not changed. Please try again shortly.',
    });
    if (progressMessageId) {
      const updated = await this.deps.larkAdapter.updateMessageById(progressMessageId, card);
      if (updated.ok) return;
      this.log.warn('data_export.failure_tracker_update_failed', {
        jobId: job.id,
        error: updated.error.message,
      });
      return;
    }
  }

  private async createProgressTracker(job: DataExportWorkerJob): Promise<string> {
    const sent = await this.deps.larkAdapter.sendToChatId(
      job.data.chatId,
      buildFinalCard({
        markdown: '# Data export in progress\nPreparing the governed export in your resolved Google destination.',
      }),
      job.data.replyToMessageId,
      deliveryKey('dtxp', job),
      job.data.replyInThread,
    );
    if (!sent.ok) throw sent.error;
    return sent.value;
  }

  private async initializeProgressTracker(messageId: string): Promise<void> {
    const updated = await this.deps.larkAdapter.updateMessageById(
      messageId,
      buildFinalCard({
        markdown: '# Data export in progress\nPreparing the governed export in your resolved Google destination.',
      }),
    );
    if (!updated.ok) throw updated.error;
  }

  private async updateProgressTracker(
    messageId: string,
    progress: {
      readonly stage: 'reading' | 'writing';
      readonly pagesRead: number;
      readonly rowsRead: number;
      readonly rowsWritten?: number;
    },
  ): Promise<void> {
    const detail = progress.stage === 'reading'
      ? `Read ${progress.rowsRead.toLocaleString('en-IN')} rows across ${progress.pagesRead.toLocaleString('en-IN')} pages.`
      : progress.rowsWritten === undefined
        ? `Read ${progress.rowsRead.toLocaleString('en-IN')} rows. Creating and verifying the Google file now.`
        : `Writing ${progress.rowsWritten.toLocaleString('en-IN')} of ${progress.rowsRead.toLocaleString('en-IN')} rows to the Google file.`;
    const updated = await this.deps.larkAdapter.updateMessageById(
      messageId,
      buildFinalCard({
        markdown: `# Data export in progress\n${detail}\n\nThe file stays private to your resolved Google destination.`,
      }),
    );
    if (!updated.ok) {
      this.log.warn('data_export.progress_update_failed', {
        messageId,
        error: updated.error.message,
      });
    }
  }
}

function deliveryKey(prefix: string, job: DataExportWorkerJob): string {
  return `${prefix}_${String(job.id ?? dataExportJobId(job.data))}`.slice(0, 50);
}

function normalizedEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

function resolvedExportRowLimit(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? DATA_EXPORT_ROW_LIMIT));
}
