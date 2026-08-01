import { Worker, type Job } from 'bullmq';
import type { Logger } from '../../shared/logger';
import { isFinalFailedAttempt } from '../../shared/queue-retry';
import {
  KNOWLEDGE_LEARNING_QUEUE_NAME,
  type KnowledgeLearningQueuePayload,
} from './knowledge-learning.queue';
import type { KnowledgeLearningService } from './knowledge-learning.service';

export class KnowledgeLearningWorker {
  private worker?: Worker<KnowledgeLearningQueuePayload>;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly redisUrl: string;
    readonly queueName?: string;
    readonly service: KnowledgeLearningService;
    readonly logger: Logger;
    readonly concurrency?: number;
    readonly reconcileIntervalMs?: number;
  }) {
    this.log = deps.logger.child({ service: 'knowledge-learning-worker' });
  }

  start(): void {
    this.worker = new Worker<KnowledgeLearningQueuePayload>(
      this.deps.queueName ?? KNOWLEDGE_LEARNING_QUEUE_NAME,
      async (job: Job<KnowledgeLearningQueuePayload>) => {
        await this.deps.service.process(job.data.knowledgeLearningJobId);
      },
      { connection: { url: this.deps.redisUrl }, concurrency: this.deps.concurrency ?? 1 },
    );
    this.worker.on('completed', job => {
      this.log.info('knowledge-learning.worker.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, cause) => {
      this.log.warn('knowledge-learning.worker.failed', { jobId: job?.id, error: String(cause) });
      if (job && isFinalFailedAttempt(job)) {
        void this.deps.service.markJobFailed(job.data.knowledgeLearningJobId, cause);
      }
    });

    const reconcile = () => {
      void this.deps.service.reconcileQueuedJobs().catch(cause => {
        this.log.warn('knowledge-learning.worker.reconcile_failed', { error: String(cause) });
      });
    };
    reconcile();
    this.reconcileTimer = setInterval(reconcile, this.deps.reconcileIntervalMs ?? 30_000);
    this.reconcileTimer.unref?.();
    this.log.info('knowledge-learning.worker.started', { concurrency: this.deps.concurrency ?? 1 });
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.worker?.close();
  }
}
