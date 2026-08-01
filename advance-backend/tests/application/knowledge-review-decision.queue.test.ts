import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeReviewDecisionQueue } from '../../src/application/knowledge/knowledge-review-decision.queue.ts';

describe('KnowledgeReviewDecisionQueue', () => {
  it('uses one stable BullMQ job identity per review', async () => {
    const calls: unknown[] = [];
    const queue = new KnowledgeReviewDecisionQueue(
      'redis://unused',
      {
        add: async (...args: unknown[]) => {
          calls.push(args);
          return { id: 'knowledge_review_review-1' };
        },
        close: async () => undefined,
      } as never,
    );

    assert.equal(await queue.enqueue('review-1'), 'knowledge_review_review-1');
    assert.deepEqual(calls, [[
      'process',
      { reviewId: 'review-1' },
      { jobId: 'knowledge_review_review-1' },
    ]]);
  });
});
