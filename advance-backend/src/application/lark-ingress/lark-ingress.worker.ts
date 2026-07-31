import { Worker, type Job } from 'bullmq';
import type {
  IngressReceipt,
  IngressReceiptRepoPort,
} from '../../infrastructure/persistence/ingress-receipt.repository';
import type { Logger } from '../../shared/logger';
import {
  LARK_INGRESS_QUEUE_NAME,
  type LarkIngressJobPayload,
  type LarkIngressQueue,
} from './lark-ingress.queue';

export interface LarkIngressWorkerDeps {
  redisUrl: string;
  queueName?: string;
  queue: LarkIngressQueue;
  receiptRepo: IngressReceiptRepoPort;
  processReceipt: (receipt: IngressReceipt) => Promise<void>;
  logger: Logger;
  concurrency?: number;
  reconcileIntervalMs?: number;
  /**
   * How long after acceptance a receipt stays retryable. Past it the receipt is
   * dead-lettered rather than retried forever. This is deliberately measured in
   * time, not attempts: the queue's own in-job retries would exhaust an attempt
   * budget within seconds, turning a brief provider outage into a permanent
   * drop. Failure classification (Wave 2B) can later terminate known-permanent
   * errors sooner; this window is the backstop, not the classifier.
   */
  retryWindowMs?: number;
  /** How long a `processing` receipt may be silent before another worker may claim it. */
  staleProcessingAfterMs?: number;
}

const DEFAULT_RETRY_WINDOW_MS = 6 * 60 * 60_000;
const RECOVERY_BATCH_SIZE = 100;

export class LarkIngressWorker {
  private worker?: Worker<LarkIngressJobPayload>;
  private reconcileTimer?: NodeJS.Timeout;
  private readonly log: Logger;

  constructor(private readonly deps: LarkIngressWorkerDeps) {
    this.log = deps.logger.child({ service: 'lark-ingress-worker' });
  }

  start(): void {
    this.worker = new Worker<LarkIngressJobPayload>(
      this.deps.queueName ?? LARK_INGRESS_QUEUE_NAME,
      async (job: Job<LarkIngressJobPayload>) => this.process(job),
      {
        connection: { url: this.deps.redisUrl },
        concurrency: this.deps.concurrency ?? 10,
      },
    );
    this.worker.on('completed', job => {
      this.log.info('lark-ingress.worker.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, error) => {
      this.log.warn('lark-ingress.worker.failed', { jobId: job?.id, error: String(error) });
    });

    const reconcile = () => {
      void this.reconcile().catch(error => {
        this.log.warn('lark-ingress.worker.reconcile_failed', { error: String(error) });
      });
    };
    reconcile();
    this.reconcileTimer = setInterval(reconcile, this.deps.reconcileIntervalMs ?? 30_000);
    this.reconcileTimer.unref?.();
    this.log.info('lark-ingress.worker.started', {
      concurrency: this.deps.concurrency ?? 10,
    });
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.worker?.close();
  }

  private get retryWindowMs(): number {
    return this.deps.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  }

  async process(job: Job<LarkIngressJobPayload>): Promise<void> {
    const claimed = await this.deps.receiptRepo.claim(job.data.receiptId, {
      ...(this.deps.staleProcessingAfterMs !== undefined
        ? { staleProcessingAfterMs: this.deps.staleProcessingAfterMs }
        : {}),
    });
    if (!claimed.ok) throw claimed.error;

    // Finished by another attempt — completing this job is correct.
    if (claimed.value.outcome === 'terminal') return;

    // Someone else holds the lease. Returning here would complete the job, and
    // `queue.recover` only re-drives *failed* jobs, so the receipt could never
    // be picked up again. Fail instead, so the retry lands after the lease has
    // had time to either finish or go stale.
    if (claimed.value.outcome === 'leased') {
      this.log.warn('lark-ingress.worker.lease_held', { receiptId: job.data.receiptId });
      throw new Error(`Lark ingress receipt ${job.data.receiptId} is leased by another worker`);
    }

    const receipt = claimed.value.receipt;
    try {
      await this.deps.processReceipt(receipt);
      const completed = await this.deps.receiptRepo.markCompleted(receipt.receiptId);
      if (!completed.ok) throw completed.error;
    } catch (error) {
      const ageMs = Date.now() - receipt.acceptedAt.getTime();
      const terminal = ageMs >= this.retryWindowMs;
      const failed = await this.deps.receiptRepo.markFailed(
        receipt.receiptId,
        error,
        { terminal },
      );
      if (!failed.ok) {
        this.log.error('lark-ingress.worker.failure_persist_failed', {
          receiptId: receipt.receiptId,
          error: failed.error.message,
        });
      }
      if (terminal) {
        // Dead-lettered, not dropped: the row keeps its payload and last error.
        // Operator-facing replay is Wave 7B; until then recovery is manual.
        this.log.error('lark-ingress.worker.dead_lettered', {
          receiptId: receipt.receiptId,
          attempts: receipt.attempts,
          ageMs,
          error: String(error),
        });
      }
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    const options = {
      retryWindowMs: this.retryWindowMs,
      ...(this.deps.staleProcessingAfterMs !== undefined
        ? { staleProcessingAfterMs: this.deps.staleProcessingAfterMs }
        : {}),
    };

    // Receipts past their window can no longer be recovered by retrying, and a
    // worker killed mid-run leaves one stranded in `processing` that no failure
    // path will ever close. Retire them explicitly so they surface as `dead`
    // rather than sitting invisible in a non-terminal state forever.
    const exhausted = await this.deps.receiptRepo.listExhausted(RECOVERY_BATCH_SIZE, options);
    if (!exhausted.ok) throw exhausted.error;
    for (const receiptId of exhausted.value) {
      const retired = await this.deps.receiptRepo.markFailed(
        receiptId,
        new Error('Ingress retry window elapsed before the receipt completed'),
        { terminal: true },
      );
      if (!retired.ok) {
        this.log.error('lark-ingress.worker.retire_failed', {
          receiptId,
          error: retired.error.message,
        });
        continue;
      }
      this.log.error('lark-ingress.worker.dead_lettered', {
        receiptId,
        reason: 'retry_window_elapsed',
      });
    }

    const recoverable = await this.deps.receiptRepo.listRecoverable(RECOVERY_BATCH_SIZE, options);
    if (!recoverable.ok) throw recoverable.error;
    await Promise.all(recoverable.value.map(receiptId => this.deps.queue.recover(receiptId)));
  }
}
