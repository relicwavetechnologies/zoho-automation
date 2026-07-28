import { Queue } from 'bullmq';

export const INGESTION_QUEUE_NAME = 'ingestion';

export const resolveIngestionQueueName = (queueName?: string): string =>
  queueName ?? INGESTION_QUEUE_NAME;

export interface IngestionJobPayload {
  jobType:        'buffer' | 'lark_file' | 'lark_image';
  companyId:      string;
  uploaderUserId: string;
  uploaderChannel: string;
  fileName:       string;
  mimeType:       string;
  /** Base64-encoded file bytes (for buffer jobs). */
  bufferBase64?:  string;
  /** Lark file_key or image_key (for Lark jobs). */
  larkFileKey?:   string;
  /** Lark message_id that contains the attachment (required for message-resource download). */
  larkMessageId?: string;
  /** Chat ID — used to send the completion/failure reply. */
  chatId?:        string;
  /** Message ID of the original file message to quote-reply to when indexing finishes. */
  replyToMessageId?: string;
  /** Immutable delivery mode captured when the job is queued. */
  replyInThread?: boolean;
  /** Group-context message ID to update after background indexing. */
  groupContextMessageId?: string;
  /**
   * Access scope for a file that arrived through Lark: everyone who can search
   * from this chat can retrieve it, and nobody else. Stamped onto every chunk's
   * vector payload. Absent for desktop uploads, which fall back to
   * `visibility` + `ownerUserId` alone.
   */
  larkChatId?:    string;
  allowedRoles?:  string[];
  visibility?:    'personal' | 'shared' | 'public';
}

export class IngestionQueue {
  private readonly queue: Queue<IngestionJobPayload>;

  constructor(redisUrl: string, queueName?: string) {
    this.queue = new Queue<IngestionJobPayload>(resolveIngestionQueueName(queueName), {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts:    3,
        backoff:     { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail:     { count: 200 },
      },
    });
  }

  async enqueue(payload: IngestionJobPayload): Promise<string> {
    const rawId = `${payload.companyId}:${payload.uploaderUserId}:${Date.now()}:${payload.larkFileKey ?? payload.fileName}`;
    const job = await this.queue.add('ingest', payload as any, {
      jobId: rawId.replaceAll(':', '_'),
    });
    return job.id ?? '';
  }

  getQueue(): Queue<IngestionJobPayload> {
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
