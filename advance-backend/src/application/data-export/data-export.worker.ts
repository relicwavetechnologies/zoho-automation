import { randomUUID } from 'node:crypto';
import { DelayedError, Worker, type Job } from 'bullmq';
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
import { dataExportFailureReason, PermanentDataExportError } from './data-export.errors';
import {
  dataExportJobId,
  resolveDataExportQueueName,
} from './data-export.queue';
import type {
  DataExportCompletion,
  DataExportCoverage,
  DataExportCoverageCause,
  DataExportJobPayload,
} from './data-export.types';
import {
  dataExportParts,
  datasetSourceShapeKey,
  datasetSourceToolId,
} from './data-export.types';
import {
  DATA_EXPORT_GENERIC_SPOOL_BYTE_LIMIT,
  dataExportRowLimitForFormat,
} from './data-export-limits';
import type {
  DataExportDestinationSink,
  GoogleExportAuth,
} from './data-export.destination';
import type { DatasetSourceRegistry } from './data-export.source-registry';
import type { ConversationRepoPort } from '../../infrastructure/persistence/conversation.repository';
import type { LaneLeaseHolder } from '../channels/lane-lease.holder';
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
  /** Fences one export job across replicas; its durable BullMQ job is the V2-lite run record. */
  readonly runLeaseHolder?: Pick<LaneLeaseHolder, 'withLane' | 'holdsLane'>;
  readonly logger: Logger;
  readonly concurrency?: number;
  readonly inactivityMs?: number;
  readonly maxRows?: number;
}

export type DataExportWorkerJob = Pick<
  Job<DataExportJobPayload>,
  'id' | 'data' | 'attemptsMade' | 'opts' | 'updateData' | 'updateProgress'
> & Partial<Pick<Job<DataExportJobPayload>, 'moveToDelayed' | 'token'>>;

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
    const runLeaseHolder = this.deps.runLeaseHolder;
    if (!runLeaseHolder) return this.processJobUnderLease(job);

    try {
      const outcome = await runLeaseHolder.withLane(
        dataExportRunLaneKey(job),
        async (lease, signal) => this.processJobUnderLease(job, {
          signal,
          holdsLease: () => runLeaseHolder.holdsLane(lease),
        }),
      );
      if (outcome.outcome === 'deferred') {
        this.log.info('data_export.worker.lease_deferred', {
          jobId: job.id,
          ownerId: outcome.ownerId,
          expiresAt: outcome.expiresAt.toISOString(),
        });
        await this.deferLeaseRecovery(job, outcome.expiresAt.getTime() + 1_000);
      }
      if (outcome.outcome === 'lost') await this.deferLeaseRecovery(job);
    } catch (error) {
      if (isDataExportRunLeaseLostError(error)) await this.deferLeaseRecovery(job);
      throw error;
    }
  }

  private async deferLeaseRecovery(
    job: DataExportWorkerJob,
    retryAt = Date.now() + 5_000,
  ): Promise<never> {
    if (!job.moveToDelayed || !job.token) {
      throw new Error('Data export lease recovery requires an active BullMQ job token');
    }
    await job.moveToDelayed(retryAt, job.token);
    // BullMQ recognizes this sentinel and leaves the manually delayed job
    // alone, including its attempt count. Throwing an ordinary error here
    // would turn lease churn into a terminal failed export.
    throw new DelayedError();
  }

  private async processJobUnderLease(
    job: DataExportWorkerJob,
    runLease?: {
      readonly signal: AbortSignal;
      readonly holdsLease: () => Promise<boolean>;
    },
  ): Promise<void> {
    let payload = job.data;
    let progressMessageId = payload.progressMessageId;
    const assertLeaseHeld = async () => {
      if (runLease?.signal.aborted) throw new DataExportRunLeaseLostError();
      if (runLease && !await runLease.holdsLease()) throw new DataExportRunLeaseLostError();
    };
    try {
      await assertLeaseHeld();
      if (!progressMessageId) {
        progressMessageId = await this.createProgressTracker(job);
        payload = { ...payload, progressMessageId };
        await job.updateData(payload);
      } else if (!payload.completedExport) {
        await this.initializeProgressTracker(progressMessageId);
      }
      const completion = payload.completedExport
        ?? await this.runExport(job, payload, progressMessageId, runLease?.signal);
      await assertLeaseHeld();
      if (!payload.completedExport) {
        payload = { ...payload, completedExport: completion };
        await job.updateData(payload);
      }
      let continuityAvailable = true;
      try {
        await assertLeaseHeld();
        await this.recordCompletionResource(job, payload, completion);
      } catch (error) {
        if (isDataExportRunLeaseLostError(error)) throw error;
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (!finalAttempt) throw error;
        this.log.error('data_export.continuity_unavailable', {
          jobId: job.id,
          error: String(error),
        });
        continuityAvailable = false;
      }
      await assertLeaseHeld();
      await this.deliverCompletion(
        job,
        payload,
        completion,
        progressMessageId,
        continuityAvailable,
      );
    } catch (error) {
      if (isDataExportRunLeaseLostError(error)) throw error;
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
    runLeaseSignal?: AbortSignal,
  ): Promise<DataExportCompletion> {
    if (runLeaseSignal?.aborted) throw new DataExportRunLeaseLostError();
    const identityResult = await this.deps.identityRepo.resolveByUserId(payload.userId, payload.companyId);
    if (!identityResult.ok) throw new Error(`Could not re-check export identity: ${identityResult.error.message}`);
    if (!identityResult.value) {
      throw new PermanentDataExportError(
        'You no longer have access to this workspace, so Divo cannot create the export.',
        'Export requester no longer has active company access',
      );
    }
    const identity = identityResult.value;
    const readerEmail = normalizedEmail(identity.email);
    if (!readerEmail) {
      throw new PermanentDataExportError(
        'Divo needs a verified email address on your Lark account before it can share an export with you.',
        'Data export requires a verified email for the invoking Lark user',
      );
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
      throw new PermanentDataExportError(
        'Your permission to create exports was removed before this one started.',
        'Data export permission was revoked before the job started',
      );
    }
    // Every part is re-authorized, not just part 0: one revoked tool must not
    // ride along inside an export that another part still permits.
    const parts = dataExportParts(payload);
    for (const part of parts) {
      const sourceToolId = datasetSourceToolId(part);
      if (!permission.value.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
        throw new PermanentDataExportError(
          `Your permission to read ${sourceToolId} data was removed before this export started.`,
          `${sourceToolId} read permission was revoked before the export started`,
        );
      }
      if (
        part.kind === 'zoho_books'
        && permission.value.department?.zohoReadScope === 'personalized'
      ) {
        throw new PermanentDataExportError(
          'Complete Zoho exports need full company Zoho read access, and yours is limited to your own records.',
          'Complete Zoho exports require full company Zoho read scope',
        );
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
      throw new PermanentDataExportError(
        `The company export account can only share files with a verified ${googleAuth.readerDomain} address, and yours is not one.`,
        `Data export can only share with a verified ${googleAuth.readerDomain} invoker`,
      );
    }
    const inactivityMs = this.deps.inactivityMs ?? 10 * 60 * 1_000;
    const abortController = new AbortController();
    const forwardRunLeaseAbort = () => abortController.abort(new DataExportRunLeaseLostError());
    runLeaseSignal?.addEventListener('abort', forwardRunLeaseAbort, { once: true });
    if (runLeaseSignal?.aborted) forwardRunLeaseAbort();
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
    const rowCapCause: DataExportCoverageCause = this.deps.maxRows === undefined
      ? 'destination_row_cap'
      : 'export_row_cap';
    let partialCause: DataExportCoverageCause | undefined;
    let knownOmittedRows: number | undefined;
    let inputRowsRead = 0;
    let requestedWindowSatisfied = false;
    const requestedRowsByPart = new Map<number, number>();
    let inputIndex = 0;
    let outputIndex = 0;
    let pageCount = 0;
    let lastTrackerUpdateAt = 0;
    let limitNeedsProbe = false;
    const updateProgressTracker = this.updateProgressTracker.bind(this);
    const markPartial = (
      cause: DataExportCoverageCause,
      options: { readonly knownOmittedRows?: number; readonly override?: boolean } = {},
    ) => {
      if (partialCause && !options.override) return;
      partialCause = cause;
      knownOmittedRows = options.knownOmittedRows;
    };
    const coverageFor = (rowsWritten: number): DataExportCoverage => {
      const requestedRows = requestedRowsByPart.size > 0
        ? [...requestedRowsByPart.values()].reduce((total, value) => total + value, 0)
        : undefined;
      return {
        ...(requestedRows === undefined ? {} : { requestedRows }),
        inputRowsRead,
        rowsWritten,
        outcome: partialCause
          ? 'partial'
          : requestedWindowSatisfied
            ? 'requested_window_satisfied'
            : 'complete',
        ...(partialCause ? { cause: partialCause } : {}),
        ...(knownOmittedRows === undefined ? {} : { knownOmittedRows }),
      };
    };
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
            inputRowsRead += page.rows.length;
            if (page.requestedRows !== undefined) {
              const prior = requestedRowsByPart.get(partIndex);
              if (prior !== undefined && prior !== page.requestedRows) {
                throw new Error(`Data export source changed its requested row window within part ${partIndex + 1}`);
              }
              requestedRowsByPart.set(partIndex, page.requestedRows);
            }
            if (page.coverage?.outcome === 'requested_window_satisfied') {
              requestedWindowSatisfied = true;
            } else if (page.coverage?.outcome === 'partial') {
              markPartial(page.coverage.cause, {
                ...(page.coverage.knownOmittedRows === undefined
                  ? {}
                  : { knownOmittedRows: page.coverage.knownOmittedRows }),
              });
            } else if (page.sourceTruncated === true) {
              markPartial('provider_limit');
            }
            if (limitNeedsProbe) {
              // `hasMore` can mean another provider partition rather than an
              // actual row (Zoho status filters do this), so only a row proves
              // that the exact row-cap boundary omitted data.
              if (page.rows.length > 0) {
                markPartial(rowCapCause, { override: true });
                exhausted = true;
                break;
              }
              // An empty page proves nothing. Keep probing across pages and
              // parts rather than declaring the export partial.
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
            if (omittedRows) {
              markPartial(rowCapCause, { override: true });
            }
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
            if (omittedRows) {
              exhausted = true;
              break;
            }
            limitNeedsProbe = limitReached;
          }
        } catch (cause) {
          if (isDataExportRunLeaseLostError(cause)) throw cause;
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
      const sinkCompletion = await this.deps.sink.write({
        auth: googleAuth,
        readerEmail,
        exportKey: String(job.id ?? dataExportJobId(payload)),
        source: payload.source,
        destination: payload.destination,
        rows: transformedPages,
        coverage: coverageFor,
        sourceTruncated: () => coverageFor(outputIndex).outcome === 'partial',
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
      const completion = sinkCompletion.coverage
        ? {
            ...sinkCompletion,
            sourceTruncated: sinkCompletion.coverage.outcome === 'partial',
          }
        : sinkCompletion;
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
      runLeaseSignal?.removeEventListener('abort', forwardRunLeaseAbort);
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
    const warning = completion.coverage?.outcome === 'partial' || (!completion.coverage && completion.sourceTruncated)
      ? `\n\n⚠️ ${truncationWarning(completion.coverage)}`
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
    // "Try again shortly" is false for a disconnected destination or a recipe
    // the provider rejects — the member retries, waits, and fails identically.
    // When the failure named a reason, say that instead.
    const reason = dataExportFailureReason(error);
    const card = buildFinalCard({
      markdown: [
        '# Data export could not finish',
        reason ?? 'Divo could not complete this export. Please try again shortly.',
        'Your source data was not changed.',
      ].join('\n\n'),
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

class DataExportRunLeaseLostError extends Error {
  constructor() {
    super('Data export run lease was lost before publication could finish');
    this.name = 'DataExportRunLeaseLostError';
  }
}

function isDataExportRunLeaseLostError(error: unknown): boolean {
  if (error instanceof DataExportRunLeaseLostError) return true;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof DataExportRunLeaseLostError;
}

function dataExportRunLaneKey(job: DataExportWorkerJob): string {
  return `data-export:${String(job.id ?? dataExportJobId(job.data))}`;
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

function truncationWarning(coverage: DataExportCoverage | undefined): string {
  if (!coverage || !coverage.cause) {
    return 'This export may be partial because an earlier Divo version recorded omitted rows without their cause.';
  }
  const cause = {
    provider_limit: 'The provider stopped this export before all upstream rows could be read.',
    export_row_cap: 'Divo\'s export row cap stopped this export.',
    destination_row_cap: 'The selected export format\'s row cap stopped this export.',
    destination_cell_cap: 'The selected export format\'s cell cap stopped this export.',
    spool_cap: 'Divo\'s temporary export spool cap stopped this export.',
  }[coverage.cause];
  const omitted = coverage.knownOmittedRows === undefined
    ? ''
    : ` ${coverage.knownOmittedRows.toLocaleString('en-IN')} row${coverage.knownOmittedRows === 1 ? '' : 's'} were omitted.`;
  return `${cause}${omitted}`;
}
