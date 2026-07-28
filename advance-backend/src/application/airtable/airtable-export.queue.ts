import { Queue } from 'bullmq';
import { sha256CanonicalJson } from '../../shared/hash';

export const AIRTABLE_EXPORT_QUEUE_NAME = 'airtable-export';

export interface AirtableExportCompletion {
  readonly success: boolean;
  readonly message: string;
  readonly csvLink?: string;
  readonly csvPublicId?: string;
  readonly csvExpiresAt?: string;
  readonly totalFetched: number;
  readonly sourceTruncated: boolean;
}

export interface AirtableExportJobPayload {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly connectionId: string;
  readonly toolId: string;
  readonly nativeTool: 'list_records_for_table' | 'search_records';
  readonly input: Readonly<Record<string, unknown>>;
  readonly chatId: string;
  readonly requestId: string;
  readonly traceId?: string;
  readonly completedExport?: AirtableExportCompletion;
}

export function airtableExportJobId(payload: AirtableExportJobPayload): string {
  return `atx_${sha256CanonicalJson({
    companyId: payload.companyId,
    userId: payload.userId,
    connectionId: payload.connectionId,
    toolId: payload.toolId,
    nativeTool: payload.nativeTool,
    input: payload.input,
    requestId: payload.requestId,
  }).slice(0, 32)}`;
}

export const resolveAirtableExportQueueName = (queueName?: string): string =>
  queueName ?? AIRTABLE_EXPORT_QUEUE_NAME;

export class AirtableExportQueue {
  private readonly queue: Queue<AirtableExportJobPayload>;

  constructor(redisUrl: string, queueName?: string) {
    this.queue = new Queue<AirtableExportJobPayload>(resolveAirtableExportQueueName(queueName), {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 200 },
      },
    });
  }

  async enqueue(payload: AirtableExportJobPayload): Promise<string> {
    const job = await this.queue.add('export-records', payload, {
      jobId: airtableExportJobId(payload),
    });
    return job.id ?? airtableExportJobId(payload);
  }

  getQueue(): Queue<AirtableExportJobPayload> {
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
