import { Worker, type Job } from 'bullmq';
import type { Logger } from '../../shared/logger';
import { isFinalFailedAttempt, isUnrecoverableJobError } from '../../shared/queue-retry';
import { MANAGER_TEACH_QUEUE_NAME, type ManagerTeachQueuePayload } from './manager-teach.queue';
import { ManagerTeachService } from './manager-teach.service';

/** A media job holds its lock for as long as ffmpeg, OCR and STT need. */
const LOCK_DURATION_MS = 5 * 60_000;
const STALLED_CHECK_INTERVAL_MS = 60_000;
/** Forgive a couple of stalls so a restart does not destroy the teaching. */
const MAX_STALLED_COUNT = 3;

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
        await this.deps.service.processIngestion(job.data.teachSessionId);
        return 'ingestion_finished';
      },
      {
        connection: { url: this.deps.redisUrl, maxRetriesPerRequest: null },
        concurrency: this.deps.concurrency ?? 1,
        // Media ingestion runs for minutes at a stretch. With the 30s default
        // every backend restart — and every slow step — tripped the stall
        // detector, which burns the job through UnrecoverableError instead of
        // a normal retry. A long lock plus a few forgiven stalls means an
        // ordinary restart costs a re-run, not the teaching.
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALLED_CHECK_INTERVAL_MS,
        maxStalledCount: MAX_STALLED_COUNT,
      },
    );
    this.worker.on('completed', job => {
      this.log.info('manager-teach.worker.finished', {
        jobId: job.id,
        outcome: job.returnvalue,
      });
    });
    this.worker.on('failed', (job, error) => {
      const stalled = isUnrecoverableJobError(error);
      this.log.warn('manager-teach.worker.failed', {
        jobId: job?.id,
        attempt: job?.attemptsMade,
        willRetry: Boolean(job) && !isFinalFailedAttempt(job, error),
        stalled,
        error: String(error),
      });
      if (!job) return;

      // A stall means the worker vanished, not that the teaching is bad. The
      // recording is intact on the server, so release the claim and let the
      // sweep re-queue it rather than reporting a failure the manager cannot
      // act on.
      if (stalled) {
        void this.deps.service
          .recoverStalledIngestions({ staleAfterMs: 0 })
          .catch(recoverError => {
            this.log.warn('manager-teach.worker.stall_recovery_failed', {
              jobId: job.id,
              error: String(recoverError),
            });
          });
        return;
      }

      if (isFinalFailedAttempt(job, error)) {
        void this.deps.service.markFailed(job.data.teachSessionId, error);
      }
    });

    const reconcile = () => {
      void (async () => {
        // Stalled sessions are released back to `queued` first, so the same
        // tick re-enqueues them. Without this a job whose worker vanished sat
        // in `ingesting` forever — never retried, never failed, and shown to
        // the manager as still in progress.
        await this.deps.service.recoverStalledIngestions();
        await this.deps.service.reconcileQueuedSessions();
      })().catch(error => {
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
