import { Queue } from 'bullmq';

export const KNOWLEDGE_LEARNING_QUEUE_NAME = 'knowledge-learning';

export interface KnowledgeLearningQueuePayload {
  readonly knowledgeLearningJobId: string;
}

export interface KnowledgeLearningQueuePort {
  enqueue(payload: KnowledgeLearningQueuePayload): Promise<string>;
}

export class KnowledgeLearningQueue implements KnowledgeLearningQueuePort {
  private readonly queue: Queue<KnowledgeLearningQueuePayload>;

  constructor(redisUrl: string, queueName = KNOWLEDGE_LEARNING_QUEUE_NAME) {
    this.queue = new Queue<KnowledgeLearningQueuePayload>(queueName, {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        // A completed DB job is authoritative. Removing the BullMQ envelope
        // lets reconciliation recreate it if a worker died before DB commit.
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      },
    });
  }

  async enqueue(payload: KnowledgeLearningQueuePayload): Promise<string> {
    const job = await this.queue.add('extract-personal-knowledge', payload, {
      jobId: `knowledge_learning_${payload.knowledgeLearningJobId}`,
    });
    return job.id ?? '';
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
