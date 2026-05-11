import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partitionRecentMessages } from '../../src/application/chat-context/lark-chat-context.service.ts';
import type { GroupChatMessage } from '../../src/domain/conversation/group-context.ts';

function makeMsg(content: string): GroupChatMessage {
  return {
    id: `msg-${Math.random()}`,
    senderOpenId: 'ou_test',
    senderName: 'Test User',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    botMentioned: false,
  };
}

describe('partitionRecentMessages', () => {
  it('returns all messages when under min threshold', () => {
    const messages = Array.from({ length: 10 }, () => makeMsg('short'));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.equal(compactedChunk.length, 0);
    assert.equal(retained.length, 10);
  });

  it('retains minimum messages even when token budget exceeded', () => {
    const messages = Array.from({ length: 50 }, () => makeMsg('x'.repeat(10_000)));
    const { retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.ok(retained.length >= 40, `expected at least 40, got ${retained.length}`);
  });

  it('caps at max messages', () => {
    const messages = Array.from({ length: 250 }, () => makeMsg('short'));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.equal(compactedChunk.length + retained.length, 200);
  });

  it('compacts older messages when budget is exceeded beyond min', () => {
    const messages = Array.from({ length: 100 }, () => makeMsg('x'.repeat(5_000)));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.ok(compactedChunk.length > 0, 'should compact some older messages');
    assert.ok(retained.length >= 40, 'should retain at least min messages');
    assert.equal(compactedChunk.length + retained.length, 100);
  });

  it('returns empty compacted chunk when all fit within budget', () => {
    const messages = Array.from({ length: 50 }, () => makeMsg('hello'));
    const { compactedChunk, retained } = partitionRecentMessages(messages, 80_000, 40, 200);
    assert.equal(compactedChunk.length, 0);
    assert.equal(retained.length, 50);
  });
});
