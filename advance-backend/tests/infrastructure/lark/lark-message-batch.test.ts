import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  absorbLaneBurst,
  completeAbsorbedReceipts,
  toBatchableMessage,
} from '../../../src/infrastructure/channels/lark/lark-message-batch.ts';
import { ok, err } from '../../../src/shared/result.ts';
import { wrapInfra } from '../../../src/shared/errors.ts';
import type { Logger } from '../../../src/shared/logger.ts';

const silent: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => silent,
};

/**
 * Built through `toBatchableMessage` rather than written out by hand, so the
 * anchor's lane key is the one production derives. A literal here would never
 * match a parsed sibling's, and every merge test would pass by not merging.
 */
const anchor = toBatchableMessage(
  {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    userExternalId: 'ou_alice',
    text: 'first',
    tenantKey: 't1',
    appId: 'app-1',
  } as any,
  {},
  1_000,
);

/** A pending sibling as the repository would return it. */
const pending = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  receiptId: `r_${id}`,
  messageId: id,
  payload: { messageId: id, text, ...over },
  acceptedAt: new Date(1_100),
});

/** Parses the stub payload shape above into what the batcher needs. */
const adapter = {
  parseIncoming: (payload: any) => ok({
    messageId: payload.messageId,
    chatId: 'oc_1',
    chatType: 'p2p',
    userExternalId: payload.sender ?? 'ou_alice',
    text: payload.text,
    tenantKey: 't1',
    appId: 'app-1',
  }),
} as any;

const repo = (over: Record<string, unknown> = {}) => ({
  listBatchable: async () => ok([]),
  claim: async () => ok({ outcome: 'claimed' as const, receipt: {} as any }),
  markCompleted: async () => ok(undefined),
  ...over,
}) as any;

describe('absorbLaneBurst', () => {
  it('runs alone when nothing else is waiting', async () => {
    const result = await absorbLaneBurst({
      anchor, anchorReceiptId: 'r_om_1', repo: repo(), adapter, log: silent,
    });

    assert.equal(result.batch.text, 'first');
    assert.deepEqual(result.absorbedReceiptIds, []);
  });

  it('absorbs a compatible sibling it successfully claimed', async () => {
    const claimed: string[] = [];
    const result = await absorbLaneBurst({
      anchor,
      anchorReceiptId: 'r_om_1',
      repo: repo({
        listBatchable: async () => ok([pending('om_2', 'second')]),
        claim: async (id: string) => {
          claimed.push(id);
          return ok({ outcome: 'claimed' as const, receipt: {} as any });
        },
      }),
      adapter,
      log: silent,
    });

    assert.equal(result.batch.text, 'first\nsecond');
    assert.deepEqual(result.absorbedReceiptIds, ['r_om_2']);
    assert.deepEqual(claimed, ['r_om_2'], 'claimed before merging, not after');
  });

  it('leaves a sibling alone when another worker already owns it', async () => {
    const result = await absorbLaneBurst({
      anchor,
      anchorReceiptId: 'r_om_1',
      repo: repo({
        listBatchable: async () => ok([pending('om_2', 'second')]),
        claim: async () => ok({ outcome: 'leased' as const }),
      }),
      adapter,
      log: silent,
    });

    // Merging a message something else is responsible for answers it twice.
    assert.equal(result.batch.text, 'first');
    assert.deepEqual(result.absorbedReceiptIds, []);
  });

  it('does not absorb a sibling from a different sender', async () => {
    const result = await absorbLaneBurst({
      anchor,
      anchorReceiptId: 'r_om_1',
      repo: repo({
        listBatchable: async () => ok([pending('om_2', 'second', { sender: 'ou_bob' })]),
      }),
      adapter,
      log: silent,
    });

    assert.equal(result.batch.text, 'first');
    assert.deepEqual(result.absorbedReceiptIds, []);
  });

  it('runs the anchor alone when the lookup fails', async () => {
    const result = await absorbLaneBurst({
      anchor,
      anchorReceiptId: 'r_om_1',
      repo: repo({
        listBatchable: async () => err(wrapInfra('prisma', 'listBatchable', new Error('down'))),
      }),
      adapter,
      log: silent,
    });

    // Batching is an optimisation. Losing it costs one extra turn; refusing to
    // run because the lookup failed costs the answer.
    assert.equal(result.batch.text, 'first');
    assert.deepEqual(result.absorbedReceiptIds, []);
  });

  it('claims no sibling it does not go on to merge', async () => {
    const claimed: string[] = [];
    const result = await absorbLaneBurst({
      anchor,
      anchorReceiptId: 'r_om_1',
      repo: repo({
        // Bob's message is first in arrival order, which makes the whole batch
        // stop there — so neither his nor the later one may be claimed.
        listBatchable: async () => ok([
          pending('om_2', 'bob speaks', { sender: 'ou_bob' }),
          pending('om_3', 'mine again'),
        ]),
        claim: async (id: string) => {
          claimed.push(id);
          return ok({ outcome: 'claimed' as const, receipt: {} as any });
        },
      }),
      adapter,
      log: silent,
    });

    // A claimed-but-unmerged receipt is a message nobody answers.
    assert.deepEqual(claimed, []);
    assert.deepEqual(result.absorbedReceiptIds, []);
    assert.equal(result.batch.text, 'first');
  });
});

describe('completeAbsorbedReceipts', () => {
  it('completes every absorbed receipt', async () => {
    const completed: string[] = [];
    await completeAbsorbedReceipts(['r_a', 'r_b'], repo({
      markCompleted: async (id: string) => { completed.push(id); return ok(undefined); },
    }), silent);

    assert.deepEqual(completed, ['r_a', 'r_b']);
  });

  it('does not throw when a completion fails', async () => {
    // The run has already replied. Throwing here fails a job whose real work is
    // done, which retries the turn and asks the model the same question again.
    await completeAbsorbedReceipts(['r_a'], repo({
      markCompleted: async () => err(wrapInfra('prisma', 'markCompleted', new Error('down'))),
    }), silent);
  });
});
