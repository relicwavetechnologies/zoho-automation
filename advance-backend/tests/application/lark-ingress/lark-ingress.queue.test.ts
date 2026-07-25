import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LarkIngressQueue } from '../../../src/application/lark-ingress/lark-ingress.queue.ts';

describe('LarkIngressQueue', () => {
  it('retries a retained failed job instead of treating its stable ID as queued', async () => {
    const retried: string[] = [];
    let added = false;
    const queue = new LarkIngressQueue(
      'redis://unused',
      'test-lark-ingress',
      {
        getJob: async () => ({
          id: 'lark_ingress_receipt-1',
          getState: async () => 'failed',
          retry: async (state: string) => {
            retried.push(state);
          },
        }),
        add: async () => {
          added = true;
          return { id: 'unexpected' };
        },
        close: async () => {},
      } as any,
    );

    const jobId = await queue.recover('receipt-1');

    assert.equal(jobId, 'lark_ingress_receipt-1');
    assert.deepEqual(retried, ['failed']);
    assert.equal(added, false);
  });
});
