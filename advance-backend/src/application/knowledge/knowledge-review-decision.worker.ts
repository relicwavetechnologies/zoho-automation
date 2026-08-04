import { Worker, type Job } from 'bullmq';
import type { Logger } from '../../shared/logger';
import type { LarkKnowledgeReviewService } from './lark-knowledge-review.service';
import {
  KNOWLEDGE_REVIEW_DECISION_QUEUE_NAME,
  type KnowledgeReviewDecisionJobPayload,
} from './knowledge-review-decision.queue';
import { isUnrecoverableJobError } from '../../shared/queue-retry';

export interface KnowledgeReviewDecisionWorkerDeps {
  redisUrl: string;
  service: Pick<
    LarkKnowledgeReviewService,
    'processQueuedDecision' | 'finalizeQueuedDecisionFailure'
  >;
  logger: Logger;
  concurrency?: number;
}

export class KnowledgeReviewDecisionWorker {
  private worker?: Worker<KnowledgeReviewDecisionJobPayload>;
  private readonly log: Logger;

  constructor(private readonly deps: KnowledgeReviewDecisionWorkerDeps) {
    this.log = deps.logger.child({ service: 'knowledge-review-decision-worker' });
  }

  start(): void {
    this.worker = new Worker<KnowledgeReviewDecisionJobPayload>(
      KNOWLEDGE_REVIEW_DECISION_QUEUE_NAME,
      async (job: Job<KnowledgeReviewDecisionJobPayload>) => {
        try {
          await this.deps.service.processQueuedDecision(job.data.reviewId);
        } catch (error) {
          const finalAttempt = isUnrecoverableJobError(error)
            || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          if (finalAttempt) {
            await this.deps.service.finalizeQueuedDecisionFailure(
              job.data.reviewId,
              error,
            );
          }
          throw error;
        }
      },
      {
        connection: { url: this.deps.redisUrl },
        concurrency: this.deps.concurrency ?? 5,
      },
    );
    this.worker.on('completed', job => {
      this.log.info('knowledge_review.worker.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, error) => {
      this.log.warn('knowledge_review.worker.failed', {
        jobId: job?.id,
        error: String(error),
      });
    });
    this.log.info('knowledge_review.worker.started', {
      concurrency: this.deps.concurrency ?? 5,
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }
}
