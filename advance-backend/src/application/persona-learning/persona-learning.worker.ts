import { Worker, type Job } from 'bullmq';
import type { Logger } from '../../shared/logger';
import { PERSONA_LEARNING_QUEUE_NAME, type PersonaLearningQueuePayload } from './persona-learning.queue';
import { PersonaLearningService } from './persona-learning.service';

export interface PersonaLearningWorkerDeps {
  readonly redisUrl: string;
  readonly queueName?: string;
  readonly service: PersonaLearningService;
  readonly logger: Logger;
  readonly concurrency?: number;
  readonly reconcileIntervalMs?: number;
}

export class PersonaLearningWorker {
  private worker?: Worker<PersonaLearningQueuePayload>;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly log: Logger;

  constructor(private readonly deps: PersonaLearningWorkerDeps) {
    this.log = deps.logger.child({ service: 'persona-learning-worker' });
  }

  start(): void {
    this.worker = new Worker<PersonaLearningQueuePayload>(
      this.deps.queueName ?? PERSONA_LEARNING_QUEUE_NAME,
      async (job: Job<PersonaLearningQueuePayload>) => {
        await this.deps.service.processShadowExtraction(job.data.personaLearningJobId);
      },
      { connection: { url: this.deps.redisUrl }, concurrency: this.deps.concurrency ?? 1 },
    );
    this.worker.on('completed', job => {
      this.log.info('persona-learning.worker.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, error) => {
      this.log.warn('persona-learning.worker.failed', { jobId: job?.id, error: String(error) });
      if (job && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        void this.deps.service.markJobFailed(job.data.personaLearningJobId, error);
      }
    });

    const reconcile = () => {
      void this.deps.service.reconcileQueuedJobs().catch(error => {
        this.log.warn('persona-learning.worker.reconcile_failed', { error: String(error) });
      });
    };
    reconcile();
    this.reconcileTimer = setInterval(reconcile, this.deps.reconcileIntervalMs ?? 30_000);
    this.reconcileTimer.unref?.();
    this.log.info('persona-learning.worker.started', { concurrency: this.deps.concurrency ?? 1 });
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.worker?.close();
  }
}
