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
}

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

  async process(job: Job<LarkIngressJobPayload>): Promise<void> {
    const claimed = await this.deps.receiptRepo.claim(job.data.receiptId);
    if (!claimed.ok) throw claimed.error;
    if (!claimed.value) return;

    try {
      await this.deps.processReceipt(claimed.value);
      const completed = await this.deps.receiptRepo.markCompleted(claimed.value.receiptId);
      if (!completed.ok) throw completed.error;
    } catch (error) {
      const failed = await this.deps.receiptRepo.markFailed(claimed.value.receiptId, error);
      if (!failed.ok) {
        this.log.error('lark-ingress.worker.failure_persist_failed', {
          receiptId: claimed.value.receiptId,
          error: failed.error.message,
        });
      }
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    const recoverable = await this.deps.receiptRepo.listRecoverable(100);
    if (!recoverable.ok) throw recoverable.error;
    await Promise.all(recoverable.value.map(receiptId => this.deps.queue.recover(receiptId)));
  }
}
