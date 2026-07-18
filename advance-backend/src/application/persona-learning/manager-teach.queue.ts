import { Queue } from 'bullmq';

export const MANAGER_TEACH_QUEUE_NAME = 'manager-teach';

export interface ManagerTeachQueuePayload {
  readonly teachSessionId: string;
}

export class ManagerTeachQueue {
  private readonly queue: Queue<ManagerTeachQueuePayload>;

  constructor(
    redisUrl: string,
    queueName = MANAGER_TEACH_QUEUE_NAME,
  ) {
    this.queue = new Queue<ManagerTeachQueuePayload>(queueName, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 1_000 },
      },
    });
  }

  async enqueue(payload: ManagerTeachQueuePayload): Promise<string> {
    const job = await this.queue.add(
      'ingest-recording',
      payload,
      {
        jobId: `manager_teach_ingest_${payload.teachSessionId}`,
      },
    );
    return String(job.id);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
