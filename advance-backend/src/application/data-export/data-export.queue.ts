import { Queue } from 'bullmq';
import { sha256CanonicalJson } from '../../shared/hash';
import type { DataExportJobPayload } from './data-export.types';

export const DATA_EXPORT_QUEUE_NAME = 'data-export';

export function dataExportJobId(payload: DataExportJobPayload): string {
  return `dtx_${sha256CanonicalJson({
    companyId: payload.companyId,
    userId: payload.userId,
    requestId: payload.requestId,
  }).slice(0, 32)}`;
}

export function dataExportSpecHash(payload: DataExportJobPayload): string {
  return sha256CanonicalJson({
    companyId: payload.companyId,
    userId: payload.userId,
    departmentId: payload.departmentId,
    source: payload.source,
    transform: payload.transform,
    destination: payload.destination,
    chatId: payload.chatId,
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

  async enqueue(payload: DataExportJobPayload): Promise<string> {
    const jobId = dataExportJobId(payload);
    const existing = await this.queue.getJob(jobId);
    if (existing) return assertMatchingRequestJob(existing.data, payload, jobId);

    const job = await this.queue.add('export-dataset', payload, { jobId });
    const persisted = await this.queue.getJob(jobId);
    return assertMatchingRequestJob(persisted?.data ?? job.data, payload, job.id ?? jobId);
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
