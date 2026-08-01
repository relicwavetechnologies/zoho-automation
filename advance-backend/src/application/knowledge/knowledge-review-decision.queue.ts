import { Queue } from 'bullmq';

export const KNOWLEDGE_REVIEW_DECISION_QUEUE_NAME = 'knowledge-review-decision';

export interface KnowledgeReviewDecisionJobPayload {
  reviewId: string;
}

type KnowledgeReviewDecisionQueueClient = Pick<
  Queue<KnowledgeReviewDecisionJobPayload>,
  'add' | 'close'
>;

export interface KnowledgeReviewDecisionQueuePort {
  enqueue(reviewId: string): Promise<string>;
}

export class KnowledgeReviewDecisionQueue implements KnowledgeReviewDecisionQueuePort {
  private readonly queue: KnowledgeReviewDecisionQueueClient;

  constructor(
    redisUrl: string,
    queue?: KnowledgeReviewDecisionQueueClient,
  ) {
    this.queue = queue ?? new Queue<KnowledgeReviewDecisionJobPayload>(
      KNOWLEDGE_REVIEW_DECISION_QUEUE_NAME,
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

  async enqueue(reviewId: string): Promise<string> {
    const job = await this.queue.add(
      'process',
      { reviewId },
      { jobId: `knowledge_review_${reviewId}` },
    );
    return job.id ?? '';
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
