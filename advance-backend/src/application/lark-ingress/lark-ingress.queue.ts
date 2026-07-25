import { Queue } from 'bullmq';

export const LARK_INGRESS_QUEUE_NAME = 'lark-ingress';

export interface LarkIngressJobPayload {
  receiptId: string;
}

type LarkIngressQueueClient = Pick<
  Queue<LarkIngressJobPayload>,
  'add' | 'getJob' | 'close'
>;

export class LarkIngressQueue {
  private readonly queue: LarkIngressQueueClient;

  constructor(
    redisUrl: string,
    queueName = LARK_INGRESS_QUEUE_NAME,
    queue?: LarkIngressQueueClient,
  ) {
    this.queue = queue ?? new Queue<LarkIngressJobPayload>(queueName, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 500 },
      },
    });
  }

  async enqueue(receiptId: string): Promise<string> {
    return this.add(receiptId);
  }

  async recover(receiptId: string): Promise<string> {
    const jobId = this.jobId(receiptId);
    const existing = await this.queue.getJob(jobId);
    if (!existing) return this.add(receiptId);
    if (await existing.getState() !== 'failed') return existing.id ?? jobId;

    try {
      await existing.retry('failed');
    } catch (error) {
      // Another replica may have recovered or removed the job after getState().
      const current = await this.queue.getJob(jobId);
      if (!current) return this.add(receiptId);
      if (await current.getState() === 'failed') throw error;
    }
    return existing.id ?? jobId;
  }

  private async add(receiptId: string): Promise<string> {
    const job = await this.queue.add(
      'process',
      { receiptId },
      { jobId: this.jobId(receiptId) },
    );
    return job.id ?? '';
  }

  private jobId(receiptId: string): string {
    return `lark_ingress_${receiptId}`;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
