import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBatchCompatible,
  buildMessageBatch,
  DEFAULT_BATCH_BOUNDS,
  type BatchableMessage,
} from '../../src/domain/channel/message-batch.ts';

const message = (over: Partial<BatchableMessage> = {}): BatchableMessage => ({
  messageId: 'om_1',
  laneKey: 'lane-a',
  requesterExternalId: 'ou_alice',
  chatId: 'oc_1',
  text: 'first thought',
  hasAttachments: false,
  isCommand: false,
  acceptedAtMs: 1_000,
  ...over,
});

describe('isBatchCompatible', () => {
  const anchor = message();

  it('merges consecutive plain messages from the same sender in one lane', () => {
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', text: 'and also this' })),
      true,
    );
  });

  it('never merges across senders', () => {
    // Authority is resolved per sender. Merging Bob's words into Alice's turn
    // would run his request with her permissions.
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', requesterExternalId: 'ou_bob' })),
      false,
    );
  });

  it('never merges across threads or roots', () => {
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', threadId: 'omt_x' })),
      false,
    );
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', rootMessageId: 'om_root' })),
      false,
    );
  });

  it('never merges messages quoting different parents', () => {
    // A different quote is a different question, however similar the words.
    assert.equal(
      isBatchCompatible(
        message({ parentMessageId: 'om_a' }),
        message({ messageId: 'om_2', parentMessageId: 'om_b' }),
      ),
      false,
    );
  });

  it('never merges anything carrying an attachment', () => {
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', hasAttachments: true })),
      false,
    );
    assert.equal(
      isBatchCompatible(message({ hasAttachments: true }), message({ messageId: 'om_2' })),
      false,
    );
  });

  it('never merges commands', () => {
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', isCommand: true })),
      false,
    );
    assert.equal(
      isBatchCompatible(message({ isCommand: true }), message({ messageId: 'om_2' })),
      false,
    );
  });

  it('never merges across lanes', () => {
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', laneKey: 'lane-b' })),
      false,
    );
  });

  it('does not merge a message with itself', () => {
    assert.equal(isBatchCompatible(anchor, message()), false);
  });

  it('ignores an empty message rather than folding a blank line into the turn', () => {
    assert.equal(
      isBatchCompatible(anchor, message({ messageId: 'om_2', text: '   ' })),
      false,
    );
  });
});

describe('buildMessageBatch', () => {
  it('joins compatible messages in arrival order', () => {
    const batch = buildMessageBatch(message({ text: 'one' }), [
      message({ messageId: 'om_3', text: 'three', acceptedAtMs: 3_000 }),
      message({ messageId: 'om_2', text: 'two', acceptedAtMs: 2_000 }),
    ]);

    // Sorted by arrival, not by the order the database happened to return:
    // answering someone's words back to front changes what they asked.
    assert.equal(batch.text, 'one\ntwo\nthree');
    assert.deepEqual(batch.sourceMessageIds, ['om_1', 'om_2', 'om_3']);
  });

  it('records every source message so the run audit shows what it answered', () => {
    const batch = buildMessageBatch(message(), [
      message({ messageId: 'om_2', acceptedAtMs: 1_100 }),
    ]);

    assert.deepEqual(batch.sourceMessageIds, ['om_1', 'om_2']);
    assert.equal(batch.merged.length, 1);
  });

  it('stops at the message-count bound', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      message({ messageId: `om_${i + 2}`, acceptedAtMs: 1_000 + i }));

    const batch = buildMessageBatch(message(), candidates);

    assert.equal(batch.sourceMessageIds.length, DEFAULT_BATCH_BOUNDS.maxMessages);
  });

  it('stops at the character bound', () => {
    const long = 'x'.repeat(3_000);
    const batch = buildMessageBatch(message({ text: long }), [
      message({ messageId: 'om_2', text: long, acceptedAtMs: 1_100 }),
    ]);

    assert.equal(batch.merged.length, 0, 'two long messages exceed the cap');
  });

  it('stops at the time window', () => {
    const batch = buildMessageBatch(message(), [
      message({
        messageId: 'om_2',
        acceptedAtMs: 1_000 + DEFAULT_BATCH_BOUNDS.windowMs + 1,
      }),
    ]);

    // Past the window it is a new thought, not a continuation.
    assert.equal(batch.merged.length, 0);
  });

  it('stops at the first incompatible message rather than skipping past it', () => {
    const batch = buildMessageBatch(message(), [
      message({ messageId: 'om_2', requesterExternalId: 'ou_bob', acceptedAtMs: 1_100 }),
      message({ messageId: 'om_3', text: 'mine again', acceptedAtMs: 1_200 }),
    ]);

    // Absorbing om_3 while leaving Bob's om_2 to run separately would answer
    // Alice's two lines around his, in an order nobody wrote.
    assert.deepEqual(batch.sourceMessageIds, ['om_1']);
  });

  it('returns the anchor alone when nothing is pending', () => {
    const batch = buildMessageBatch(message({ text: 'solo' }), []);

    assert.equal(batch.text, 'solo');
    assert.deepEqual(batch.sourceMessageIds, ['om_1']);
    assert.deepEqual(batch.merged, []);
  });
});
