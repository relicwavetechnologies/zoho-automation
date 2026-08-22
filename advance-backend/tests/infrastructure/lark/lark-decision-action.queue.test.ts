import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkDecisionActionQueue } from '../../../src/infrastructure/channels/lark/lark-decision-action.queue.ts';

const payload = {
  cardEvent: { action: { value: { kind: 'decision_answer' } } },
  envelope: { header: { event_type: 'card.action.trigger' } },
  eventHeader: { event_id: 'event-1' },
};

describe('Lark Decision action queue', () => {
  it('persists one stable job before ACK', async () => {
    const calls: unknown[] = [];
    const queue = new LarkDecisionActionQueue('redis://unused', {
      getJob: async () => undefined,
      add: async (...args: unknown[]) => {
        calls.push(args);
        return { id: (args[2] as { jobId: string }).jobId };
      },
      close: async () => undefined,
    } as never);

    const first = await queue.enqueue(payload);
    const second = await queue.enqueue(payload);

    assert.equal(first, second);
    assert.equal(calls.length, 2);
    assert.equal((calls[0] as any)[2].jobId, (calls[1] as any)[2].jobId);
  });

  it('recovers a retained failed job instead of silently accepting it', async () => {
    const retried: string[] = [];
    const queue = new LarkDecisionActionQueue('redis://unused', {
      getJob: async () => ({
        id: 'lark_decision_existing',
        getState: async () => 'failed',
        retry: async (state: string) => { retried.push(state); },
      }),
      add: async () => { throw new Error('must not add a duplicate'); },
      close: async () => undefined,
    } as never);

    assert.equal(await queue.enqueue(payload), 'lark_decision_existing');
    assert.deepEqual(retried, ['failed']);
  });
});
