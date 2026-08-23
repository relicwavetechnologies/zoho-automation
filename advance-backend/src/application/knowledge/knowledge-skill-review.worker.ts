import type { Logger } from '../../shared/logger';
import type { KnowledgeSkillReviewService } from './knowledge-skill-review.service';

/** Repairs linked authority state and terminal Lark delivery from durable DB rows. */
export class KnowledgeSkillReviewWorker {
  private timer: NodeJS.Timeout | undefined;
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly reviews: Pick<KnowledgeSkillReviewService, 'reconcileLinkedOutcomes'>;
    readonly logger: Logger;
    readonly intervalMs?: number;
  }) {
    this.log = deps.logger.child({ module: 'knowledge-skill-review-worker' });
  }

  start(): void {
    const reconcile = () => {
      void this.deps.reviews.reconcileLinkedOutcomes().catch(error => {
        this.log.error('knowledge_skill_review.reconcile_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    reconcile();
    this.timer = setInterval(reconcile, this.deps.intervalMs ?? 15_000);
    this.timer.unref?.();
    this.log.info('knowledge_skill_review.worker_started', {
      intervalMs: this.deps.intervalMs ?? 15_000,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
