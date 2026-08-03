import { Queue } from 'bullmq';
import { sha256CanonicalJson } from '../../shared/hash';
import type { DataExportJobPayload } from './data-export.types';

export const DATA_EXPORT_QUEUE_NAME = 'data-export';

/**
 * Identity of the *dataset* one user request is offering. Deliberately blind to
 * destination format, so every tool call in a run lands on the same offer and
 * its parts merge instead of colliding.
 */
export function dataExportOfferKey(payload: DataExportJobPayload): string {
  return `dtx_${sha256CanonicalJson({
    companyId: payload.companyId,
    userId: payload.userId,
    requestId: payload.requestId,
  }).slice(0, 32)}`;
}

/**
 * Identity of one *artifact*. The Lark card offers Google Sheet, CSV and Excel
 * side by side, which are three files; leaving format out of this key made them
 * one job, so the second and third buttons resolved to the first click's
 * artifact and silently produced nothing.
 */
export function dataExportJobId(payload: DataExportJobPayload): string {
  return `dtx_${sha256CanonicalJson({
    companyId: payload.companyId,
    userId: payload.userId,
    requestId: payload.requestId,
    format: payload.destination.format,
  }).slice(0, 32)}`;
}

export function dataExportSpecHash(payload: DataExportJobPayload): string {
  return sha256CanonicalJson({
    companyId: payload.companyId,
    userId: payload.userId,
    departmentId: payload.departmentId,
    source: payload.source,
    // Parts and the observed count are part of the identity of a request:
    // appending a part must change this hash so the offer update can use it as
    // a compare-and-set token against a concurrent append.
    additionalParts: payload.additionalParts,
    observedRowCount: payload.observedRowCount,
    transform: payload.transform,
    destination: payload.destination,
    chatId: payload.chatId,
    replyToMessageId: payload.replyToMessageId,
    replyInThread: payload.replyInThread,
    requestId: payload.requestId,
  });
}

export const resolveDataExportQueueName = (queueName?: string): string =>
  queueName ?? DATA_EXPORT_QUEUE_NAME;

export class DataExportQueue {
  private readonly queue: Queue<DataExportJobPayload>;

  constructor(redisUrl: string, queueName?: string) {
    this.queue = new Queue<DataExportJobPayload>(resolveDataExportQueueName(queueName), {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 200 },
      },
    });
  }

  /**
   * `added` distinguishes "this call created the job" from "a job with this id
   * was already here". Without it a caller cannot tell a queued export from a
   * no-op, and would report success for work that will never run.
   */
  async enqueue(
    payload: DataExportJobPayload,
  ): Promise<{ readonly jobId: string; readonly added: boolean }> {
    const jobId = dataExportJobId(payload);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      return { jobId: assertMatchingRequestJob(existing.data, payload, jobId), added: false };
    }

    const job = await this.queue.add('export-dataset', payload, { jobId });
    const persisted = await this.queue.getJob(jobId);
    return {
      jobId: assertMatchingRequestJob(persisted?.data ?? job.data, payload, job.id ?? jobId),
      added: true,
    };
  }

  getQueue(): Queue<DataExportJobPayload> {
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

function assertMatchingRequestJob(
  queued: DataExportJobPayload,
  requested: DataExportJobPayload,
  jobId: string,
): string {
  if (dataExportSpecHash(queued) !== dataExportSpecHash(requested)) {
    throw new Error(
      'Only one data export can be queued per user request. Ask the user to choose one dataset before exporting.',
    );
  }
  return jobId;
}
