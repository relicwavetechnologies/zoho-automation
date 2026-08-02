import { Worker, type Job } from 'bullmq';
import type { Logger } from '../../shared/logger';
import {
  WORKBOOK_CONVERSION_QUEUE_NAME,
  type WorkbookConversionJobPayload,
} from './workbook-conversion.queue';
import type {
  GoogleDriveXlsxConversionJob,
  GoogleDriveXlsxConversionResult,
} from './google-drive-xlsx-conversion.worker';

const LOCK_DURATION_MS = 5 * 60_000;
const STALLED_INTERVAL_MS = 60_000;

type WorkbookConversionCore = {
  process(
    job: GoogleDriveXlsxConversionJob,
    options: { readonly finalAttempt: boolean },
  ): Promise<GoogleDriveXlsxConversionResult>;
};

export class GoogleDriveXlsxConversionConsumer {
  private worker: Worker<WorkbookConversionJobPayload> | undefined;
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly redisUrl: string;
    readonly queueName?: string;
    readonly core: WorkbookConversionCore;
    readonly logger: Logger;
    readonly concurrency?: number;
  }) {
    this.log = deps.logger.child({ service: 'google-drive-xlsx-conversion' });
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<WorkbookConversionJobPayload>(
      this.deps.queueName ?? WORKBOOK_CONVERSION_QUEUE_NAME,
      job => this.processJob(job),
      {
        connection: { url: this.deps.redisUrl, maxRetriesPerRequest: null },
        concurrency: this.deps.concurrency ?? 1,
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALLED_INTERVAL_MS,
        maxStalledCount: 2,
      },
    );
    this.worker.on('completed', job => {
      this.log.info('google_drive_xlsx_conversion.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, error) => {
      this.log.warn('google_drive_xlsx_conversion.failed', {
        jobId: job?.id,
        attempt: job?.attemptsMade,
        error: String(error),
      });
    });
    this.log.info('google_drive_xlsx_conversion.started', {
      queueName: this.deps.queueName ?? WORKBOOK_CONVERSION_QUEUE_NAME,
      concurrency: this.deps.concurrency ?? 1,
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }

  async processJob(
    job: Pick<Job<WorkbookConversionJobPayload>, 'id' | 'data' | 'attemptsMade' | 'opts'>,
  ): Promise<void> {
    const result = await this.deps.core.process(conversionJob(job), {
      // BullMQ increments attemptsMade after the processor rejects, so the
      // current attempt is attemptsMade + 1 while we are inside it.
      finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });
    if (result.disposition === 'in_progress') {
      // A concurrent owner must finish or lose its Redis lease before BullMQ
      // retries. Completing this job here would strand the request forever.
      throw new WorkbookConversionLeaseHeldError();
    }
  }
}

function conversionJob(
  job: Pick<Job<WorkbookConversionJobPayload>, 'id' | 'data'>,
): GoogleDriveXlsxConversionJob {
  if (!job.id) throw new Error('Workbook conversion queue job is missing its deterministic ID.');
  return {
    jobKey: job.id,
    companyId: job.data.companyId,
    userId: job.data.userId,
    sourceConnectionId: job.data.connectionId,
    sourceFileId: job.data.fileId,
    sourceTitle: job.data.fileName?.trim() || 'Excel workbook',
  };
}

export class WorkbookConversionLeaseHeldError extends Error {
  constructor() {
    super('Workbook conversion is currently held by another worker.');
    this.name = 'WorkbookConversionLeaseHeldError';
  }
}
