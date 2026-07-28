import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conversationKeyForMessage } from '../../src/domain/conversation/conversation-key.ts';

describe('conversation key', () => {
  it('keys a DM on the chat alone', () => {
    assert.equal(
      conversationKeyForMessage({ chatId: 'oc_dm', chatType: 'p2p', messageId: 'om_1' }),
      'oc_dm',
    );
  });

  it('keys inline group conversations per user', () => {
    const alice = conversationKeyForMessage({
      chatId: 'oc_room',
      chatType: 'group',
      messageId: 'om_1',
      userExternalId: 'ou_alice',
      groupReplyMode: 'inline',
    });
    const aliceLater = conversationKeyForMessage({
      chatId: 'oc_room',
      chatType: 'group',
      messageId: 'om_2',
      userExternalId: 'ou_alice',
      groupReplyMode: 'inline',
    });
    const bob = conversationKeyForMessage({
      chatId: 'oc_room',
      chatType: 'group',
      messageId: 'om_3',
      userExternalId: 'ou_bob',
      groupReplyMode: 'inline',
    });

    assert.equal(alice, 'oc_room:user:ou_alice');
    assert.equal(aliceLater, alice);
    assert.notEqual(bob, alice);
  });

  it('separates two threads in the same group chat', () => {
    const alice = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_a2', rootMessageId: 'om_alice',
    });
    const bob = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_b2', rootMessageId: 'om_bob',
    });

    assert.notEqual(alice, bob, 'threads in one room must not share a key');
    assert.equal(alice, 'oc_room:thread:om_alice');
  });

  it('gives every turn of one thread the same key', () => {
    // The whole point: continuity within a thread, isolation across threads.
    const first = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_2', rootMessageId: 'om_root',
    });
    const second = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_3', rootMessageId: 'om_root',
    });
    assert.equal(first, second);
  });

  it('prefers the root message over a topic ID assigned later', () => {
    // Lark assigns a topic ID only once the thread exists, so the seed message
    // has no `thread_id` and its replies do. Preferring the topic ID would give
    // the seed turn and the first reply different keys.
    assert.equal(
      conversationKeyForMessage({
        chatId: 'oc_room',
        chatType: 'group',
        messageId: 'om_9',
        threadId: 'omt_thread',
        rootMessageId: 'om_root',
      }),
      'oc_room:thread:om_root',
    );
  });

  it('keeps continuity when Lark adds a topic ID to the reply', () => {
    // The exact shape of the first follow-up in every group thread: the seed
    // carries neither field, the reply carries both.
    const seed = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_first',
    });
    const reply = conversationKeyForMessage({
      chatId: 'oc_room',
      chatType: 'group',
      messageId: 'om_second',
      threadId: 'omt_1',
      rootMessageId: 'om_first',
    });

    assert.equal(reply, seed, 'the reply reads the context the seed turn wrote');
  });

  it('still isolates two topics that never carry a root', () => {
    // Topic-mode rooms can supply a topic ID with no root; the fallback must
    // still keep separate topics apart.
    const one = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_x', threadId: 'omt_1',
    });
    const two = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_y', threadId: 'omt_2',
    });

    assert.notEqual(one, two);
    assert.equal(one, 'oc_room:thread:omt_1');
  });

  it('seeds a top-level group message with its own message ID', () => {
    // Divo replies in-thread, so this message is about to become a thread root.
    // The follow-up arrives carrying `om_first` as its root — keying on the chat
    // here instead would hide this turn from the reply that answers it.
    const opening = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_first',
    });
    const followUp = conversationKeyForMessage({
      chatId: 'oc_room', chatType: 'group', messageId: 'om_second', rootMessageId: 'om_first',
    });

    assert.equal(opening, 'oc_room:thread:om_first');
    assert.equal(followUp, opening, 'the follow-up finds the turn that opened the thread');
  });

  it('does not collide with a chat whose ID is a prefix of another', () => {
    // `clearChatHistories` sweeps by the `<chatId>:thread:` prefix, so the
    // separator has to make `oc_1` and `oc_12` unambiguously different.
    const shorter = conversationKeyForMessage({
      chatId: 'oc_1', chatType: 'group', messageId: 'om_x',
    });
    assert.equal(shorter, 'oc_1:thread:om_x');
    assert.ok(!shorter.startsWith('oc_12:thread:'));
  });
});
