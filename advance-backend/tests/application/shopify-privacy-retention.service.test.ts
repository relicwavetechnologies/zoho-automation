import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { drainExpiredShopifyPrivacyRequests } from '../../src/application/shopify/shopify-privacy-retention.service';
import { err, ok } from '../../src/shared/result';

describe('Shopify privacy retention drain', () => {
  it('drains every page against one stable cutoff', async () => {
    const now = new Date('2026-08-03T00:00:00.000Z');
    const calls: Array<{ now?: Date; limit?: number }> = [];
    const pages = [
      { affected: 100, hasMore: true },
      { affected: 2, hasMore: false },
    ];
    const result = await drainExpiredShopifyPrivacyRequests({
      repository: {
        sweep: async input => {
          calls.push(input);
          return ok(pages.shift()!);
        },
      },
      now,
    });

    assert.deepEqual(result, { affected: 102, hasMore: false });
    assert.deepEqual(calls, [{ now, limit: 100 }, { now, limit: 100 }]);
  });

  it('fails closed on storage failure or a non-progressing page', async () => {
    await assert.rejects(
      drainExpiredShopifyPrivacyRequests({
        repository: { sweep: async () => err({ kind: 'prisma', operation: 'sweep', message: 'down' }) },
      }),
    );
    await assert.rejects(
      drainExpiredShopifyPrivacyRequests({
        repository: { sweep: async () => ok({ affected: 0, hasMore: true }) },
      }),
      /made no progress/,
    );
  });

  it('returns hasMore when the explicit transaction budget is exhausted', async () => {
    const result = await drainExpiredShopifyPrivacyRequests({
      repository: { sweep: async () => ok({ affected: 1, hasMore: true }) },
      pageSize: 1,
      maxPages: 2,
    });
    assert.deepEqual(result, { affected: 2, hasMore: true });
  });
});
