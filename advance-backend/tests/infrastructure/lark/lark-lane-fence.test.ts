import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fenceFinalReplies } from '../../../src/infrastructure/channels/lark/lark-lane-fence.ts';
import { ok } from '../../../src/shared/result.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const silent: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silent,
};

const adapter = (sent: unknown[]) => ({
  sendFinalReply: async (conversation: unknown, reply: unknown) => {
    sent.push(reply);
    return ok({ messageId: 'om_sent' });
  },
  sendStatus: async () => ok({ messageId: 'om_status' }),
  name: 'lark',
}) as any;

const reply = { kind: 'final' as const, text: 'the answer', format: 'text' as const };

describe('fenceFinalReplies', () => {
  it('sends when the lane is still ours', async () => {
    const sent: unknown[] = [];
    const fenced = fenceFinalReplies(adapter(sent), async () => true, silent);

    const result = await fenced.sendFinalReply({} as any, reply);

    assert.ok(result.ok);
    assert.deepEqual(sent, [reply]);
  });

  it('refuses to publish once a newer owner has taken the lane', async () => {
    const sent: unknown[] = [];
    const fenced = fenceFinalReplies(adapter(sent), async () => false, silent);

    const result = await fenced.sendFinalReply({} as any, reply);

    // Publishing here puts a stale answer after a fresh one, which reads to the
    // user as Divo contradicting itself.
    assert.equal(result.ok, false);
    assert.deepEqual(sent, [], 'nothing reached Lark');
  });

  it('sends anyway when the fence itself cannot be checked', async () => {
    const sent: unknown[] = [];
    const fenced = fenceFinalReplies(
      adapter(sent),
      async () => { throw new Error('lease store down'); },
      silent,
    );

    const result = await fenced.sendFinalReply({} as any, reply);

    // Failing closed would drop a real reply every time the lease store
    // hiccups — a worse and far more common failure than the stale publish
    // this guards against.
    assert.ok(result.ok);
    assert.deepEqual(sent, [reply]);
  });

  it('leaves other adapter methods untouched', async () => {
    const sent: unknown[] = [];
    const fenced = fenceFinalReplies(adapter(sent), async () => false, silent);

    // Status cards are transient and get superseded anyway; fencing them would
    // add failure paths without preventing anything a user would notice.
    const status = await fenced.sendStatus({} as any, { kind: 'status', text: 'working' } as any);

    assert.ok(status.ok);
    assert.equal(fenced.name, 'lark');
  });
});
