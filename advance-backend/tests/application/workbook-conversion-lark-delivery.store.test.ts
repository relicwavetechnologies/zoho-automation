import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RedisWorkbookConversionLarkDeliveryStore } from '../../src/application/data-export/workbook-conversion-lark-delivery.store.ts';
import type { CachePort } from '../../src/shared/cache.ts';
import { ok } from '../../src/shared/result.ts';

describe('workbook conversion Lark delivery store', () => {
  it('binds one request and one reusable progress message', async () => {
    const values = new Map<string, unknown>();
    const cache: CachePort = {
      get: async key => ok(values.get(key) ?? null),
      set: async (key, value) => { values.set(key, value); return ok(undefined); },
      setNx: async (key, value) => {
        if (values.has(key)) return ok(false);
        values.set(key, value);
        return ok(true);
      },
      del: async key => { values.delete(key); return ok(undefined); },
      scanDel: async () => ok(0),
    };
    const store = new RedisWorkbookConversionLarkDeliveryStore(cache);
    const job = {
      jobKey: 'wbc_offer_1',
      chatId: 'oc_1',
      sourceMessageId: 'om_1',
      replyInThread: true,
    } as const;

    await store.register(job);
    assert.deepEqual(await store.reserveProgressMessage(job.jobKey), { status: 'claimed', job });
    assert.deepEqual(await store.reserveProgressMessage(job.jobKey), { status: 'sending' });
    const ready = await store.completeProgressMessage({ jobKey: job.jobKey, progressMessageId: 'om_progress' });
    assert.equal(ready.progressMessageId, 'om_progress');
    assert.deepEqual(await store.reserveProgressMessage(job.jobKey), { status: 'ready', state: ready });

    await assert.rejects(
      store.register({ ...job, chatId: 'oc_other' }),
      /different request details/,
    );
  });
});
