import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';

export const LARK_DECISION_ACTION_QUEUE_NAME = 'lark-decision-action';

export interface LarkDecisionActionJobPayload {
  readonly cardEvent: unknown;
  readonly envelope: Record<string, unknown>;
  readonly eventHeader?: Record<string, unknown>;
}

export interface LarkDecisionActionQueuePort {
  enqueue(payload: LarkDecisionActionJobPayload): Promise<string>;
}

type QueueClient = Pick<Queue<LarkDecisionActionJobPayload>, 'add' | 'close' | 'getJob'>;

export class LarkDecisionActionQueue implements LarkDecisionActionQueuePort {
  private readonly queue: QueueClient;

  constructor(redisUrl: string, queue?: QueueClient) {
    this.queue = queue ?? new Queue<LarkDecisionActionJobPayload>(
      LARK_DECISION_ACTION_QUEUE_NAME,
      {
        connection: { url: redisUrl },
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 500 },
        },
      },
    );
  }

  async enqueue(payload: LarkDecisionActionJobPayload): Promise<string> {
    const eventId = typeof payload.eventHeader?.['event_id'] === 'string'
      ? payload.eventHeader['event_id']
      : JSON.stringify(payload);
    const digest = createHash('sha256').update(eventId).digest('hex');
    const jobId = `lark_decision_${digest}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if (await existing.getState() === 'failed') await existing.retry('failed');
      return existing.id ?? jobId;
    }
    const job = await this.queue.add('process', payload, {
      jobId,
    });
    return job.id ?? '';
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
