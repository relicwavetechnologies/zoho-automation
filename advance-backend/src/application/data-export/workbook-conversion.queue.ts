import { Queue } from 'bullmq';
import { sha256CanonicalJson } from '../../shared/hash';

export const WORKBOOK_CONVERSION_QUEUE_NAME = 'workbook-conversion';

export interface WorkbookConversionJobPayload {
  readonly version: 1;
  readonly offerId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly sourceMessageId: string;
  readonly replyInThread: boolean;
  readonly connectionId: string;
  readonly fileId: string;
  readonly fileName?: string;
}

export interface WorkbookConversionQueuePort {
  enqueue(payload: WorkbookConversionJobPayload): Promise<string>;
}

export const workbookConversionJobId = (offerId: string): string => `wbc_${offerId}`;

export class WorkbookConversionQueue implements WorkbookConversionQueuePort {
  private readonly queue: Queue<WorkbookConversionJobPayload>;

  constructor(redisUrl: string, queueName = WORKBOOK_CONVERSION_QUEUE_NAME) {
    this.queue = new Queue<WorkbookConversionJobPayload>(queueName, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 200 },
      },
    });
  }

  async enqueue(payload: WorkbookConversionJobPayload): Promise<string> {
    const jobId = workbookConversionJobId(payload.offerId);
    const existing = await this.queue.getJob(jobId);
    if (existing) return assertMatchingJob(existing.data, payload, jobId);
    const job = await this.queue.add('convert-workbook', payload, { jobId });
    const persisted = await this.queue.getJob(jobId);
    return assertMatchingJob(persisted?.data ?? job.data, payload, job.id ?? jobId);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

function assertMatchingJob(
  queued: WorkbookConversionJobPayload,
  requested: WorkbookConversionJobPayload,
  jobId: string,
): string {
  if (sha256CanonicalJson(queued) !== sha256CanonicalJson(requested)) {
    throw new Error('This workbook conversion was already queued with different request details.');
  }
  return jobId;
}
