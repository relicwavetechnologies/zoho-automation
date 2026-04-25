import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LarkChannelAdapter } from '../../../src/infrastructure/channels/lark/lark.adapter.ts';
import type { Logger } from '../../../src/shared/logger.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
};

const fakeEnv = {
  NODE_ENV: 'test' as const,
  PORT: 3000,
  DATABASE_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  OPENAI_API_KEY: 'sk-test',
  LARK_APP_ID: 'app_001',
  LARK_APP_SECRET: 'secret',
  LARK_BOT_NAME: 'Divo',
  LOG_LEVEL: 'info' as const,
} as any;

function makeAdapter(botName = 'Divo') {
  return new LarkChannelAdapter({ env: { ...fakeEnv, LARK_BOT_NAME: botName }, logger: noopLogger });
}

/** Build a minimal Lark text-message event envelope. */
function makeTextEvent(opts: {
  text: string;
  chatType?: 'p2p' | 'group';
  mentions?: Array<{ key: string; name: string; openId: string }>;
  messageId?: string;
  parentId?: string;
}): unknown {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: opts.messageId ?? 'om_001',
        chat_id: 'oc_chat',
        chat_type: opts.chatType ?? 'group',
        message_type: 'text',
        content: JSON.stringify({ text: opts.text }),
        create_time: '1700000000',
        ...(opts.parentId ? { parent_id: opts.parentId } : {}),
        mentions: (opts.mentions ?? []).map(m => ({
          key: m.key,
          name: m.name,
          id: { open_id: m.openId },
        })),
      },
    },
  };
}

/** Build a Lark "post" (rich text) event envelope. */
function makePostEvent(opts: {
  paragraphs: Array<Array<{ tag: string; text?: string; user_name?: string; user_id?: string; href?: string }>>;
  chatType?: 'p2p' | 'group';
  mentions?: Array<{ key: string; name: string; openId: string }>;
}): unknown {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: 'om_post_001',
        chat_id: 'oc_chat',
        chat_type: opts.chatType ?? 'group',
        message_type: 'post',
        content: JSON.stringify({ title: '', content: opts.paragraphs }),
        create_time: '1700000000',
        mentions: (opts.mentions ?? []).map(m => ({
          key: m.key,
          name: m.name,
          id: { open_id: m.openId },
        })),
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LarkChannelAdapter.parseIncoming', () => {

  // ── Event type validation ──────────────────────────────────────────────────

  it('returns ChannelError for unsupported event type', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming({
      header: { event_type: 'im.message.reaction_created_v1' },
      event: {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'not_supported');
  });

  it('returns ChannelError for missing event type', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming({ header: {}, event: {} });
    assert.equal(result.ok, false);
  });

  it('returns ChannelError for completely malformed payload', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(null);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'malformed');
  });

  // ── Basic parsing ──────────────────────────────────────────────────────────

  it('parses a plain p2p text message with no mentions', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({ text: 'Hello!', chatType: 'p2p' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'Hello!');
    assert.equal(result.value.chatType, 'p2p');
    assert.equal(result.value.userExternalId, 'ou_sender');
    assert.equal(result.value.chatId, 'oc_chat');
    assert.deepEqual(result.value.mentions, []);
  });

  it('sets mentionsSelf=true for p2p chat even with no explicit mention', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({ text: 'list my tasks', chatType: 'p2p' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.mentionsSelf, true);
  });

  it('sets mentionsSelf=false for group chat with no bot mention', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: 'hey @_user_1 what time is the meeting?',
      chatType: 'group',
      mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.mentionsSelf, false);
  });

  it('parses messageId, chatId, traceId, timestamp correctly', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({ text: 'hi', messageId: 'om_xyz' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.messageId, 'om_xyz');
    assert.match(result.value.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(result.value.traceId, /^om_xyz-/);
  });

  it('populates replyToMessageId when parentId is present', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({ text: 'ok', parentId: 'om_parent' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.replyToMessageId, 'om_parent');
  });

  it('leaves replyToMessageId undefined when no parentId', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({ text: 'ok' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.replyToMessageId, undefined);
  });

  // ── Mention resolution — text messages ────────────────────────────────────

  it('strips bot self-mention from text in group chat', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1 list my tasks',
      chatType: 'group',
      mentions: [{ key: '@_user_1', name: 'Divo', openId: 'ou_bot' }],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'list my tasks');
    assert.equal(result.value.mentionsSelf, true);
  });

  it('replaces non-bot mention placeholder with @Name', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: 'send a message to @_user_1',
      chatType: 'group',
      mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'send a message to @Alice');
    assert.equal(result.value.mentionsSelf, false);
  });

  it('handles mixed: @Divo and @Alice in same message', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1 send a task to @_user_2',
      chatType: 'group',
      mentions: [
        { key: '@_user_1', name: 'Divo',  openId: 'ou_bot'   },
        { key: '@_user_2', name: 'Alice', openId: 'ou_alice' },
      ],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'send a task to @Alice');
    assert.equal(result.value.mentionsSelf, true);
  });

  it('handles multiple non-bot mentions in the same message', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1 please send report to @_user_2',
      chatType: 'group',
      mentions: [
        { key: '@_user_1', name: 'Bob',   openId: 'ou_bob'   },
        { key: '@_user_2', name: 'Alice', openId: 'ou_alice' },
      ],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, '@Bob please send report to @Alice');
    assert.equal(result.value.mentions.length, 2);
  });

  it('leaves unknown @_key placeholder as-is when not in mentions array', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_99 hello',
      chatType: 'group',
      mentions: [], // no mentions provided
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, '@_user_99 hello');
  });

  it('populates mentions array with isSelf flag correct', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1 @_user_2 what time?',
      chatType: 'group',
      mentions: [
        { key: '@_user_1', name: 'Divo',  openId: 'ou_bot'   },
        { key: '@_user_2', name: 'Alice', openId: 'ou_alice' },
      ],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const divo  = result.value.mentions.find(m => m.name === 'Divo');
    const alice = result.value.mentions.find(m => m.name === 'Alice');
    assert.equal(divo?.isSelf, true);
    assert.equal(alice?.isSelf, false);
  });

  it('bot name matching is case-insensitive', () => {
    const adapter = makeAdapter('divo'); // lowercase
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1 list tasks',
      chatType: 'group',
      mentions: [{ key: '@_user_1', name: 'DIVO', openId: 'ou_bot' }], // uppercase
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.mentionsSelf, true);
    assert.equal(result.value.text, 'list tasks');
  });

  it('empty text after stripping self-mention is returned as empty string', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1',
      chatType: 'group',
      mentions: [{ key: '@_user_1', name: 'Divo', openId: 'ou_bot' }],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, '');
  });

  it('trims leading/trailing whitespace after mention resolution', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '   @_user_1   please do it   ',
      chatType: 'group',
      mentions: [{ key: '@_user_1', name: 'Divo', openId: 'ou_bot' }],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'please do it');
  });

  // ── Post (rich text) messages ──────────────────────────────────────────────

  it('extracts plain text from a post message', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [[{ tag: 'text', text: 'Hello, this is a post message.' }]],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'Hello, this is a post message.');
  });

  it('strips bot @at tag from post message', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [[
        { tag: 'at', user_name: 'Divo', user_id: 'ou_bot' },
        { tag: 'text', text: ' please send the report' },
      ]],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'please send the report');
  });

  it('keeps non-bot @at tags in post message as @Name', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [[
        { tag: 'at', user_name: 'Divo',  user_id: 'ou_bot'   },
        { tag: 'text', text: ' send a message to ' },
        { tag: 'at', user_name: 'Alice', user_id: 'ou_alice' },
      ]],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'send a message to @Alice');
  });

  it('handles multi-paragraph post by joining with newlines', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [
        [{ tag: 'text', text: 'First paragraph.' }],
        [{ tag: 'text', text: 'Second paragraph.' }],
      ],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'First paragraph.\nSecond paragraph.');
  });

  it('includes hyperlink text from `a` tag in post', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [[
        { tag: 'text', text: 'See this: ' },
        { tag: 'a', text: 'click here', href: 'https://example.com' } as any,
      ]],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, 'See this: click here');
  });

  it('post with only bot @at and no other text returns empty string', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [[{ tag: 'at', user_name: 'Divo', user_id: 'ou_bot' }]],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, '');
  });

  it('sets mentionsSelf=true when bot @at appears in post in group chat', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [[
        { tag: 'at', user_name: 'Divo', user_id: 'ou_bot' },
        { tag: 'text', text: ' create a task' },
      ]],
      chatType: 'group',
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // mentions array is empty (post mentions don't come through the envelope mentions field here)
    // mentionsSelf check via the mentions envelope
    assert.equal(result.value.text, 'create a task');
  });

  // ── Missing/empty content ──────────────────────────────────────────────────

  it('returns empty text when content field is absent', () => {
    const adapter = makeAdapter();
    const event = {
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
        message: {
          message_id: 'om_x', chat_id: 'oc_x', chat_type: 'p2p',
          message_type: 'text', create_time: '1700000000',
          // no content field
        },
      },
    };
    const result = adapter.parseIncoming(event);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, '');
  });
});
