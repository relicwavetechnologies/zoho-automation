import { Worker, type Job } from 'bullmq';
import type { Logger } from '../../../shared/logger';
import { isUnrecoverableJobError } from '../../../shared/queue-retry';
import type { LarkDecisionActionProcessor } from './lark-decision-action.processor';
import {
  LARK_DECISION_ACTION_QUEUE_NAME,
  type LarkDecisionActionJobPayload,
} from './lark-decision-action.queue';

export class LarkDecisionActionWorker {
  private worker?: Worker<LarkDecisionActionJobPayload>;
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly redisUrl: string;
    readonly processor: Pick<LarkDecisionActionProcessor, 'process' | 'finalizeFailure'>;
    readonly logger: Logger;
    readonly concurrency?: number;
  }) {
    this.log = deps.logger.child({ module: 'lark-decision-action-worker' });
  }

  start(): void {
    this.worker = new Worker<LarkDecisionActionJobPayload>(
      LARK_DECISION_ACTION_QUEUE_NAME,
      async (job: Job<LarkDecisionActionJobPayload>) => {
        try {
          await this.deps.processor.process(job.data);
        } catch (error) {
          const finalAttempt = isUnrecoverableJobError(error)
            || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
          if (finalAttempt) await this.deps.processor.finalizeFailure(job.data, error);
          throw error;
        }
      },
      {
        connection: { url: this.deps.redisUrl },
        concurrency: this.deps.concurrency ?? 5,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.log.warn('decision_action.worker_failed', { jobId: job?.id, error: String(error) });
    });
    this.log.info('decision_action.worker_started', {
      concurrency: this.deps.concurrency ?? 5,
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }
}
