import { Worker, type Job } from 'bullmq';
import type { Logger } from '../../shared/logger';
import { MANAGER_TEACH_QUEUE_NAME, type ManagerTeachQueuePayload } from './manager-teach.queue';
import { ManagerTeachService } from './manager-teach.service';

export class ManagerTeachWorker {
  private worker: Worker<ManagerTeachQueuePayload> | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private readonly log: Logger;

  constructor(private readonly deps: {
    redisUrl: string;
    queueName?: string;
    service: ManagerTeachService;
    logger: Logger;
    concurrency?: number;
  }) {
    this.log = deps.logger.child({ service: 'manager-teach-worker' });
  }

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<ManagerTeachQueuePayload>(
      this.deps.queueName ?? MANAGER_TEACH_QUEUE_NAME,
      async (job: Job<ManagerTeachQueuePayload>) => {
        if (job.data.stage === 'synthesize') {
          return this.deps.service.processPersonaSynthesis(job.data.teachSessionId);
        }
        await this.deps.service.processIngestion(job.data.teachSessionId);
        return 'ingestion_finished';
      },
      {
        connection: { url: this.deps.redisUrl, maxRetriesPerRequest: null },
        concurrency: this.deps.concurrency ?? 1,
      },
    );
    this.worker.on('completed', job => {
      this.log.info('manager-teach.worker.finished', {
        jobId: job.id,
        stage: job.data.stage,
        outcome: job.returnvalue,
      });
    });
    this.worker.on('failed', (job, error) => {
      this.log.warn('manager-teach.worker.failed', { jobId: job?.id, error: String(error) });
      if (job && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        void this.deps.service.markFailed(job.data.teachSessionId, job.data.stage, error);
      }
    });

    const reconcile = () => {
      void this.deps.service.reconcileQueuedSessions().catch(error => {
        this.log.warn('manager-teach.worker.reconcile_failed', { error: String(error) });
      });
    };
    reconcile();
    this.reconcileTimer = setInterval(reconcile, 30_000);
    this.reconcileTimer.unref?.();

    void this.runCleanup();
    this.cleanupTimer = setInterval(() => void this.runCleanup(), 60 * 60 * 1_000);
    this.cleanupTimer.unref?.();
    this.log.info('manager-teach.worker.started', { concurrency: this.deps.concurrency ?? 1 });
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.worker?.close();
    this.worker = undefined;
  }

  private async runCleanup(): Promise<void> {
    try {
      const deleted = await this.deps.service.cleanupExpiredArtifacts();
      if (deleted > 0) this.log.info('manager-teach.cleanup.complete', { deleted });
    } catch (error) {
      this.log.warn('manager-teach.cleanup.failed', { error: String(error) });
    }
  }
}
