import { randomUUID } from 'node:crypto';
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
  dataExportParts,
  datasetSourceShapeKey,
  datasetSourceToolId,
} from './data-export.types';
import {
  DATA_EXPORT_GENERIC_SPOOL_BYTE_LIMIT,
  DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT,
  DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT,
  DATA_EXPORT_XLSX_CELL_LIMIT,
  dataExportRowLimitForFormat,
} from './data-export-limits';
import type {
  DataExportDestinationSink,
  GoogleExportAuth,
} from './data-export.destination';
import type { DatasetSourceRegistry } from './data-export.source-registry';
import type { ConversationRepoPort } from '../../infrastructure/persistence/conversation.repository';
import {
  DATA_EXPORT_RESOURCE_TOOL,
  DATA_EXPORT_RESOURCE_TTL_MS,
  type DataExportResourceRecord,
} from './data-export-continuity';

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
  readonly conversationHistory?: Pick<ConversationRepoPort, 'appendTurn'>;
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
      let continuityAvailable = true;
      try {
        await this.recordCompletionResource(job, payload, completion);
      } catch (error) {
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (!finalAttempt) throw error;
        this.log.error('data_export.continuity_unavailable', {
          jobId: job.id,
          error: String(error),
        });
        continuityAvailable = false;
      }
      await this.deliverCompletion(
        job,
        payload,
        completion,
        progressMessageId,
        continuityAvailable,
      );
    } catch (error) {
      const finalAttempt = isUnrecoverableJobError(error)
        || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt && !payload.completedExport) {
        await this.deliverFailure(job, error, progressMessageId);
      }
      throw error;
    }
  }

  private async recordCompletionResource(
    job: DataExportWorkerJob,
    payload: DataExportJobPayload,
    completion: DataExportCompletion,
  ): Promise<void> {
    if (!payload.conversationKey || !this.deps.conversationHistory) return;
    const createdAt = new Date();
    const target = payload.destination.target;
    const resource: DataExportResourceRecord = {
      version: 1,
      kind: 'data_export_resource',
      resourceRef: randomUUID(),
      ownerUserId: payload.userId,
      artifactId: completion.artifactId,
      artifactUrl: completion.artifactUrl,
      artifactType: completion.artifactType,
      rowCount: completion.rowCount,
      ...(target?.connectionId ? { connectionId: target.connectionId } : {}),
      ...(completion.artifactType === 'google_sheet'
        ? { spreadsheetId: completion.artifactId }
        : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + DATA_EXPORT_RESOURCE_TTL_MS).toISOString(),
    };
    const appended = await this.deps.conversationHistory.appendTurn(
      payload.conversationKey,
      {
        role: 'tool',
        content: `Verified ${completion.artifactType} export: ${completion.artifactUrl}`,
        timestamp: createdAt.toISOString(),
        toolName: DATA_EXPORT_RESOURCE_TOOL,
        toolOutcome: resource,
      },
      { companyId: payload.companyId, channel: 'lark' },
      { dedupeKey: `data-export:${job.id}:resource` },
    );
    if (!appended.ok) throw appended.error;
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
    // Every part is re-authorized, not just part 0: one revoked tool must not
    // ride along inside an export that another part still permits.
    const parts = dataExportParts(payload);
    for (const part of parts) {
      const sourceToolId = datasetSourceToolId(part);
      if (!permission.value.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
        throw new UnrecoverableError(`${sourceToolId} read permission was revoked before the export started`);
      }
      if (
        part.kind === 'zoho_books'
        && permission.value.department?.zohoReadScope === 'personalized'
      ) {
        throw new UnrecoverableError('Complete Zoho exports require full company Zoho read scope');
      }
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
    // Resolved up front so an unsupported part fails before anything is written.
    const adapters = parts.map(part => this.deps.sources.resolve(part));
    const sandbox = new DataExportTransformSandbox(payload.transform);
    touch();
    const maxRows = resolvedExportRowLimit(payload, this.deps.maxRows);
    let sourceTruncated = false;
    let inputIndex = 0;
    let outputIndex = 0;
    let pageCount = 0;
    let lastTrackerUpdateAt = 0;
    let limitNeedsProbe = false;
    const updateProgressTracker = this.updateProgressTracker.bind(this);
    const transformedPages = (async function* () {
      // Parts stream in the order the run produced them, through one shared row
      // index, so the transform and the row limit see a single dataset rather
      // than N restarts.
      let exhausted = false;
      for (const [partIndex, part] of parts.entries()) {
        if (exhausted) break;
        const pages = adapters[partIndex]!.read(part, {
          companyId: payload.companyId,
          userId: payload.userId,
          signal: abortController.signal,
        });
        try {
          for await (const page of pages) {
            touch();
            sourceTruncated ||= page.sourceTruncated === true;
            if (limitNeedsProbe) {
              // Any part after this one is about to be dropped, so its mere
              // existence means the export is truncated.
              if (page.rows.length > 0 || page.hasMore === true || partIndex < parts.length - 1) {
                sourceTruncated = true;
                exhausted = true;
                break;
              }
              // An empty page proves nothing — the next page of this same part
              // may still hold rows. Keep probing rather than declaring the
              // export complete.
              continue;
            }
            const remainingInput = maxRows - inputIndex;
            const inputRows = page.rows.slice(0, remainingInput);
            const transformed = await sandbox.transformPage(inputRows, inputIndex);
            inputIndex += inputRows.length;
            const remainingOutput = maxRows - outputIndex;
            const outputRows = transformed.slice(0, remainingOutput);
            outputIndex += outputRows.length;
            const limitReached = inputIndex >= maxRows || outputIndex >= maxRows;
            const omittedRows = page.rows.length > inputRows.length
              || transformed.length > outputRows.length;
            sourceTruncated ||= omittedRows || (limitReached && page.hasMore === true);
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
            if (omittedRows || (limitReached && page.hasMore !== undefined)) {
              exhausted = true;
              break;
            }
            limitNeedsProbe = limitReached;
          }
        } catch (cause) {
          // Naming the part matters: "part 7 of 22 failed" is actionable where
          // a bare provider error on a 22-call export is not.
          throw new Error(
            `Data export part ${partIndex + 1} of ${parts.length} (${datasetSourceShapeKey(part)}) could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
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
      parts: parts.length,
      observedRowCount: payload.observedRowCount ?? null,
      destination: payload.destination.format,
      destinationOwner: payload.destination.target?.kind ?? 'legacy_company_google',
    });
    try {
      const completion = await this.deps.sink.write({
        auth: googleAuth,
        readerEmail,
        exportKey: String(job.id ?? dataExportJobId(payload)),
        source: payload.source,
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
    payload: DataExportJobPayload,
    completion: DataExportCompletion,
    progressMessageId: string,
    continuityAvailable = true,
  ): Promise<void> {
    const warning = completion.sourceTruncated
      ? `\n\n⚠️ ${truncationWarning(payload, this.deps.maxRows)}`
      : '';
    const card = buildFinalCard({
      markdown: [
        '# Data export ready',
        `Exported ${completion.rowCount} row${completion.rowCount === 1 ? '' : 's'} to a verified ${completion.artifactType === 'google_sheet' ? 'Google Sheet' : completion.artifactType === 'xlsx' ? 'Excel file in Google Drive' : 'CSV in Google Drive'}.`,
        `[Open export](${completion.artifactUrl})`,
        `Access: ${completion.sharedWith}${warning}`,
        ...(continuityAvailable
          ? []
          : ['Divo could not save this file to the conversation. To work on it later, paste the export link into your message.']),
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

function resolvedExportRowLimit(
  payload: DataExportJobPayload,
  override: number | undefined,
): number {
  return Math.max(
    1,
    Math.floor(override ?? dataExportRowLimitForFormat(payload.destination.format)),
  );
}

function truncationWarning(payload: DataExportJobPayload, override: number | undefined): string {
  const limits = [
    `${resolvedExportRowLimit(payload, override).toLocaleString('en-IN')} rows`,
  ];
  if (payload.destination.format === 'xlsx') {
    limits.push(`${DATA_EXPORT_XLSX_CELL_LIMIT.toLocaleString('en-IN')} cells`);
  } else if (payload.destination.format === 'google_sheet') {
    limits.push(`${DATA_EXPORT_GOOGLE_SHEET_CELL_LIMIT.toLocaleString('en-IN')} cells`);
  }
  limits.push(payload.source.kind === 'menhood_query'
    ? `${DATA_EXPORT_MENHOOD_SPOOL_MB_LIMIT} MB spool`
    : `${DATA_EXPORT_GENERIC_SPOOL_BYTE_LIMIT / (1_024 * 1_024 * 1_024)} GiB spool`);
  return `The source/provider or an applicable safety limit truncated this export. Limits for this request: ${limits.join(', ')}.`;
}
