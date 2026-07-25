import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LarkChannelAdapter,
  shouldStartLarkAgent,
} from '../../../src/infrastructure/channels/lark/lark.adapter.ts';
import { asChatId, asCorrelationId, asMessageId } from '../../../src/shared/ids.ts';
import { planFinalCards } from '../../../src/infrastructure/channels/lark/lark-card.builder.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import type { ConversationHandle } from '../../../src/application/channels/channel.adapter.ts';
import type { FinalReply } from '../../../src/domain/channel/outbound.ts';
import { LarkApiError } from '../../../src/infrastructure/channels/lark/clients/lark-http.client.ts';

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

function makeAdapter(botName = 'Divo', logger: Logger = noopLogger) {
  return new LarkChannelAdapter({
    env: { ...fakeEnv, LARK_BOT_NAME: botName },
    logger,
    botOpenId: 'ou_bot',
  });
}

function parseCardPayload(payload: string): Record<string, unknown> {
  const outer = JSON.parse(payload) as { card: string };
  return JSON.parse(outer.card) as Record<string, unknown>;
}

function financeFixture(tableCount: number): string {
  const sections = ['# Finance Update', 'Structured finance summary'];
  for (let i = 1; i <= tableCount; i += 1) {
    sections.push(
      `## Table ${i}`,
      [
        '| Customer | Amount | Status |',
        '|---|---:|---|',
        `| Client ${i} | ₹${i * 1000} | Open |`,
        `| Client ${i + 10} | ₹${i * 2000} | Aging |`,
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

function makeConversation(correlationId = 'corr-1'): ConversationHandle {
  return {
    channel: 'lark',
    chatId: asChatId('oc_chat'),
    correlationId: asCorrelationId(correlationId),
    replyToMessageId: asMessageId('om_parent'),
    replyInThread: true,
  };
}

function makeReply(text: string): FinalReply {
  return {
    kind: 'final',
    format: 'markdown',
    text,
    branding: { departmentLabel: 'Finance', departmentColor: 'green' },
  };
}

/** Build a minimal Lark text-message event envelope. */
function makeTextEvent(opts: {
  text: string;
  chatType?: 'p2p' | 'group';
  mentions?: Array<{ key: string; name: string; openId: string; userId?: string; unionId?: string }>;
  messageId?: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
  senderType?: 'user' | 'bot' | 'app';
  senderUserId?: string;
  senderUnionId?: string;
}): unknown {
  return {
    header: {
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant-1',
      app_id: 'app-1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_sender',
          ...(opts.senderUserId ? { user_id: opts.senderUserId } : {}),
          ...(opts.senderUnionId ? { union_id: opts.senderUnionId } : {}),
        },
        sender_type: opts.senderType ?? 'user',
      },
      message: {
        message_id: opts.messageId ?? 'om_001',
        chat_id: 'oc_chat',
        chat_type: opts.chatType ?? 'group',
        message_type: 'text',
        content: JSON.stringify({ text: opts.text }),
        create_time: '1700000000',
        ...(opts.parentId ? { parent_id: opts.parentId } : {}),
        ...(opts.rootId ? { root_id: opts.rootId } : {}),
        ...(opts.threadId ? { thread_id: opts.threadId } : {}),
        mentions: (opts.mentions ?? []).map(m => ({
          key: m.key,
          name: m.name,
          id: {
            open_id: m.openId,
            ...(m.userId ? { user_id: m.userId } : {}),
            ...(m.unionId ? { union_id: m.unionId } : {}),
          },
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

  it('classifies agent admission using stable identity and sender type', () => {
    const cases = [
      {
        name: 'human DM',
        event: makeTextEvent({ text: 'hello', chatType: 'p2p' }),
        expected: true,
      },
      {
        name: 'exact bot mention',
        event: makeTextEvent({
          text: '@_user_1 help',
          chatType: 'group',
          mentions: [{ key: '@_user_1', name: 'Divo', openId: 'ou_bot' }],
        }),
        expected: true,
      },
      {
        name: 'other-user mention',
        event: makeTextEvent({
          text: '@_user_1 help',
          chatType: 'group',
          mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }],
        }),
        expected: false,
      },
      {
        name: 'display-name collision',
        event: makeTextEvent({
          text: '@_user_1 help',
          chatType: 'group',
          mentions: [{ key: '@_user_1', name: 'Divo', openId: 'ou_human_named_divo' }],
        }),
        expected: false,
      },
      {
        name: '@all',
        event: makeTextEvent({
          text: '@_all help',
          chatType: 'group',
          mentions: [{ key: '@_all', name: 'all', openId: '' }],
        }),
        expected: false,
      },
      {
        name: 'bot self echo',
        event: makeTextEvent({ text: 'sent by bot', chatType: 'p2p', senderType: 'bot' }),
        expected: false,
      },
      {
        name: 'malformed event',
        event: null,
        expected: 'parse_error',
      },
    ] as const;

    const adapter = makeAdapter();
    for (const testCase of cases) {
      const result = adapter.parseIncoming(testCase.event);
      if (testCase.expected === 'parse_error') {
        assert.equal(result.ok, false, testCase.name);
        continue;
      }
      assert.equal(result.ok, true, testCase.name);
      if (!result.ok) continue;
      assert.equal(shouldStartLarkAgent(result.value), testCase.expected, testCase.name);
    }
  });

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

  it('preserves installation, sender, parent, root, and thread identities separately', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1 ok',
      parentId: 'om_parent',
      rootId: 'om_root',
      threadId: 'omt_thread',
      senderUserId: 'on_sender',
      senderUnionId: 'un_sender',
      mentions: [{
        key: '@_user_1',
        name: 'Alice',
        openId: 'ou_alice',
        userId: 'on_alice',
        unionId: 'un_alice',
      }],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.tenantKey, 'tenant-1');
    assert.equal(result.value.appId, 'app-1');
    assert.equal(result.value.senderUserId, 'on_sender');
    assert.equal(result.value.senderUnionId, 'un_sender');
    assert.equal(result.value.parentMessageId, 'om_parent');
    assert.equal(result.value.replyToMessageId, 'om_parent');
    assert.equal(result.value.rootMessageId, 'om_root');
    assert.equal(result.value.threadId, 'omt_thread');
    assert.deepEqual(result.value.mentions[0], {
      key: '@_user_1',
      openId: 'ou_alice',
      userId: 'on_alice',
      unionId: 'un_alice',
      name: 'Alice',
      isSelf: false,
    });
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

  it('bot identity matching is independent of display name', () => {
    const adapter = makeAdapter('Renamed Divo');
    const result = adapter.parseIncoming(makeTextEvent({
      text: '@_user_1 list tasks',
      chatType: 'group',
      mentions: [{ key: '@_user_1', name: 'Legacy Bot Name', openId: 'ou_bot' }],
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
    assert.equal(result.value.text, 'create a task');
    assert.equal(result.value.mentionsSelf, true);
    assert.equal(shouldStartLarkAgent(result.value), true);
  });

  it('does not admit a post mention with the bot display name and a different ID', () => {
    const adapter = makeAdapter();
    const result = adapter.parseIncoming(makePostEvent({
      paragraphs: [[
        { tag: 'at', user_name: 'Divo', user_id: 'ou_other' },
        { tag: 'text', text: ' create a task' },
      ]],
      chatType: 'group',
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.text, '@Divo create a task');
    assert.equal(result.value.mentionsSelf, false);
    assert.equal(shouldStartLarkAgent(result.value), false);
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

describe('LarkChannelAdapter run interruption', () => {
  it('allows the run owner to interrupt their active run', () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    adapter.registerAbortController('corr-1', controller, {
      userId: 'user-1',
      companyId: 'company-1',
    });

    const result = adapter.interruptRun('corr-1', {
      userId: 'user-1',
      companyId: 'company-1',
      aiRole: 'MEMBER',
    });

    assert.equal(result, 'aborted');
    assert.equal(controller.signal.aborted, true);
    assert.equal(adapter.interruptRun('corr-1', {
      userId: 'user-1',
      companyId: 'company-1',
      aiRole: 'MEMBER',
    }), 'not_found');
  });

  it('rejects another member without consuming the active run', () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    adapter.registerAbortController('corr-1', controller, {
      userId: 'owner-1',
      companyId: 'company-1',
    });

    assert.equal(adapter.interruptRun('corr-1', {
      userId: 'member-2',
      companyId: 'company-1',
      aiRole: 'MEMBER',
    }), 'forbidden');
    assert.equal(controller.signal.aborted, false);
    assert.equal(adapter.interruptRun('corr-1', {
      userId: 'admin-1',
      companyId: 'company-1',
      aiRole: 'COMPANY_ADMIN',
    }), 'aborted');
  });

  it('rejects an admin from another company', () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    adapter.registerAbortController('corr-1', controller, {
      userId: 'owner-1',
      companyId: 'company-1',
    });

    assert.equal(adapter.interruptRun('corr-1', {
      userId: 'admin-2',
      companyId: 'company-2',
      aiRole: 'SUPER_ADMIN',
    }), 'forbidden');
    assert.equal(controller.signal.aborted, false);
  });
});

describe('LarkChannelAdapter.sendDirectCard', () => {
  it('classifies a provider rejection as definite non-delivery', async () => {
    const adapter = makeAdapter();
    (adapter as any).messagingClient = {
      sendCardToOpenId: async () => {
        throw new LarkApiError('recipient is invalid', 400, 230001);
      },
    };

    const result = await adapter.sendDirectCard('ou_invalid', '{}');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'upstream_4xx');
  });

  it('keeps a transport failure ambiguous because the provider may have accepted the card', async () => {
    const adapter = makeAdapter();
    (adapter as any).messagingClient = {
      sendCardToOpenId: async () => {
        throw new LarkApiError('connection closed before response', 0);
      },
    };

    const result = await adapter.sendDirectCard('ou_manager', '{}');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'upstream_5xx');
  });
});

describe('LarkChannelAdapter delivery timing', () => {
  it('records status and final reply delivery durations', async () => {
    const logEvents: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, fields) => logEvents.push({ event, fields }),
      warn: (event, fields) => logEvents.push({ event, fields }),
      error: () => {},
      debug: () => {},
      child: () => logger,
    };
    const adapter = makeAdapter('Divo', logger);
    const sendCalls: unknown[][] = [];
    (adapter as any).messagingClient = {
      sendMessage: async (...args: unknown[]) => {
        sendCalls.push(args);
        return { messageId: 'om_status' };
      },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    const status = await adapter.sendStatus(makeConversation(), {
      kind: 'status',
      terminal: false,
      timeline: { phase: 'Working' },
    });
    const final = await adapter.sendFinalReply(makeConversation(), makeReply('# Done'));

    assert.equal(status.ok, true);
    assert.equal(final.ok, true);
    const statusLog = logEvents.find(entry => entry.event === 'lark.status.flush.completed');
    const finalLog = logEvents.find(entry => entry.event === 'lark.adapter.final_delivery.completed');
    assert.equal(typeof statusLog?.fields?.['durationMs'], 'number');
    assert.equal(statusLog?.fields?.['correlationId'], 'corr-1');
    assert.equal(typeof finalLog?.fields?.['durationMs'], 'number');
    assert.deepEqual(sendCalls[0]?.slice(0, 1), ['oc_chat']);
    assert.equal(sendCalls[0]?.[2], 'om_parent');
    assert.equal(sendCalls[0]?.[3], true);
  });

  it('records terminal final delivery failure duration', async () => {
    const logEvents: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, fields) => logEvents.push({ event, fields }),
      warn: (event, fields) => logEvents.push({ event, fields }),
      error: () => {},
      debug: () => {},
      child: () => logger,
    };
    const adapter = makeAdapter('Divo', logger);
    (adapter as any).messagingClient = {
      sendMessage: async () => { throw new LarkApiError('Lark unavailable', 500); },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    const result = await adapter.sendFinalReply(makeConversation(), makeReply('# Done'));

    assert.equal(result.ok, false);
    const failureLog = logEvents.find(entry => entry.event === 'lark.adapter.final_delivery.failed');
    assert.equal(typeof failureLog?.fields?.['durationMs'], 'number');
    assert.equal(failureLog?.fields?.['reason'], 'upstream_5xx');
  });

  it('does not retry an ambiguous primary delivery outcome', async () => {
    const adapter = makeAdapter();
    let calls = 0;
    (adapter as any).messagingClient = {
      sendMessage: async () => {
        calls += 1;
        throw new LarkApiError('connection closed before response', 0);
      },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    const result = await adapter.sendFinalReply(makeConversation(), makeReply('# Done'));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'ambiguous_delivery');
    assert.equal(calls, 1);
  });

  it('preserves an ambiguous plain-text fallback outcome', async () => {
    const adapter = makeAdapter();
    let calls = 0;
    (adapter as any).messagingClient = {
      sendMessage: async (_chatId: string, payload: string) => {
        calls += 1;
        if (!payload.includes('"msg_type":"text"')) {
          throw new LarkApiError('card rejected', 400);
        }
        throw new LarkApiError('connection closed before response', 0);
      },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    const result = await adapter.sendFinalReply(makeConversation(), makeReply('# Done'));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'ambiguous_delivery');
    assert.equal(calls, 2);
  });

  it('reports partial delivery when continuation cards and their text fallback fail', async () => {
    const logEvents: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, fields) => logEvents.push({ event, fields }),
      warn: (event, fields) => logEvents.push({ event, fields }),
      error: (event, fields) => logEvents.push({ event, fields }),
      debug: () => {},
      child: () => logger,
    };
    const adapter = makeAdapter('Divo', logger);
    let calls = 0;
    (adapter as any).messagingClient = {
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) return { messageId: 'om_primary' };
        throw new Error('Lark unavailable');
      },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    const result = await adapter.sendFinalReply(makeConversation(), makeReply(financeFixture(4)));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'partial_delivery');
    const failureLog = logEvents.find(entry =>
      entry.event === 'lark.adapter.final_delivery.failed'
      && entry.fields?.['reason'] === 'partial_delivery');
    assert.equal(failureLog?.fields?.['messageId'], 'om_primary');
    assert.equal(logEvents.some(entry => entry.event === 'lark.adapter.final_delivery.completed'), false);
  });

  it('falls back only for continuation segments that were not delivered', async () => {
    const adapter = makeAdapter();
    const reply = makeReply(financeFixture(10));
    const expectedSegments = planFinalCards({ markdown: reply.text, branding: reply.branding });
    assert.ok(expectedSegments.length >= 3, 'fixture produces multiple continuations');
    let cardCalls = 0;
    const fallbackText: string[] = [];
    (adapter as any).messagingClient = {
      sendMessage: async (_chatId: string, payload: string) => {
        if (payload.includes('"msg_type":"text"')) {
          const outer = JSON.parse(payload) as { content: string };
          fallbackText.push((JSON.parse(outer.content) as { text: string }).text);
          return { messageId: 'om_text' };
        }
        cardCalls += 1;
        if (cardCalls === 3) throw new LarkApiError('continuation unavailable', 500);
        return { messageId: `om_card_${cardCalls}` };
      },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    const result = await adapter.sendFinalReply(makeConversation(), reply);

    assert.equal(result.ok, true);
    const fallback = fallbackText.join('\n');
    assert.equal(fallback.includes(expectedSegments[1]!.markdown.slice(0, 80)), false);
    assert.equal(fallback.includes(expectedSegments[2]!.markdown.slice(0, 80)), true);
  });

  it('reports partial delivery when plain-text fallback fails after its first chunk', async () => {
    const logEvents: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      info: (event, fields) => logEvents.push({ event, fields }),
      warn: (event, fields) => logEvents.push({ event, fields }),
      error: (event, fields) => logEvents.push({ event, fields }),
      debug: () => {},
      child: () => logger,
    };
    const adapter = makeAdapter('Divo', logger);
    let textCalls = 0;
    (adapter as any).messagingClient = {
      sendMessage: async (_chatId: string, payload: string) => {
        if (!payload.includes('"msg_type":"text"')) {
          throw new LarkApiError('card unavailable', 500);
        }
        textCalls += 1;
        if (textCalls === 1) return { messageId: 'om_text_partial' };
        throw new LarkApiError('text unavailable', 500);
      },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    const result = await adapter.sendFinalReply(
      makeConversation(),
      makeReply(`# Report\n\n${'x'.repeat(9_000)}`),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'partial_delivery');
    const failureLog = logEvents.find(entry =>
      entry.event === 'lark.adapter.final_delivery.failed'
      && entry.fields?.['reason'] === 'partial_delivery');
    assert.equal(failureLog?.fields?.['messageId'], 'om_text_partial');
    assert.equal(logEvents.some(entry => entry.event === 'lark.adapter.final_delivery.completed'), false);
  });
});

describe('LarkChannelAdapter.sendFinalReply', () => {
  it('finalizes a one-card reply in place when the status coordinator succeeds', async () => {
    const adapter = makeAdapter();
    const sendCalls: unknown[][] = [];
    const updateCalls: unknown[][] = [];
    let finalizedPayload = '';

    (adapter as any).messagingClient = {
      sendMessage: async (...args: unknown[]) => {
        sendCalls.push(args);
        return { messageId: 'om_new' };
      },
      updateMessage: async (...args: unknown[]) => {
        updateCalls.push(args);
      },
      addReaction: async () => undefined,
    };

    (adapter as any).coordinators.set('corr-1', {
      getStatusMessageId: () => 'om_status',
      finalizeMessage: async (payload: string) => {
        finalizedPayload = payload;
        return 'om_status';
      },
    });

    const result = await adapter.sendFinalReply(makeConversation(), makeReply('# Done\n\nAll good.'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.messageId, 'om_status');
    assert.equal(sendCalls.length, 0);
    assert.equal(updateCalls.length, 0);

    const card = parseCardPayload(finalizedPayload);
    const subtitle = (card['header'] as { subtitle?: { content: string } }).subtitle?.content;
    assert.equal(subtitle, 'Done');
  });

  it('splits a table-heavy reply and sends continuation cards after updating the original status card', async () => {
    const adapter = makeAdapter();
    const sendCalls: unknown[][] = [];
    let finalizedPayload = '';
    const reply = makeReply(financeFixture(4));
    const expectedSegments = planFinalCards({
      markdown: reply.text,
      branding: reply.branding,
    });

    (adapter as any).messagingClient = {
      sendMessage: async (...args: unknown[]) => {
        sendCalls.push(args);
        return { messageId: `om_followup_${sendCalls.length}` };
      },
      updateMessage: async () => undefined,
      addReaction: async () => undefined,
    };

    (adapter as any).coordinators.set('corr-1', {
      getStatusMessageId: () => 'om_status',
      finalizeMessage: async (payload: string) => {
        finalizedPayload = payload;
        return 'om_status';
      },
    });

    const result = await adapter.sendFinalReply(makeConversation(), reply);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.messageId, 'om_status');
    assert.equal(sendCalls.length, expectedSegments.length - 1);
    for (const call of sendCalls) {
      assert.equal(call[2], 'om_parent');
      assert.equal(call[3], true);
    }

    const firstCard = parseCardPayload(finalizedPayload);
    const secondCard = parseCardPayload(sendCalls[0]![1] as string);
    const firstSubtitle = (firstCard['header'] as { subtitle?: { content: string } }).subtitle?.content ?? '';
    const secondSubtitle = (secondCard['header'] as { subtitle?: { content: string } }).subtitle?.content ?? '';
    assert.equal(firstSubtitle, 'Finance Update');
    assert.equal(secondSubtitle, 'Finance Update');
  });

  it('updates the old status card to a redirect when finalize fails but sending a new card succeeds', async () => {
    const adapter = makeAdapter();
    const sendCalls: unknown[][] = [];
    const updateCalls: unknown[][] = [];

    (adapter as any).messagingClient = {
      sendMessage: async (...args: unknown[]) => {
        sendCalls.push(args);
        return { messageId: 'om_followup' };
      },
      updateMessage: async (...args: unknown[]) => {
        updateCalls.push(args);
      },
      addReaction: async () => undefined,
    };

    (adapter as any).coordinators.set('corr-1', {
      getStatusMessageId: () => 'om_status',
      finalizeMessage: async () => {
        throw new LarkApiError('Lark update failed', 500);
      },
    });

    const result = await adapter.sendFinalReply(makeConversation(), makeReply('# Done\n\nAll good.'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(sendCalls.length, 1);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0]?.[0], 'om_status');

    const redirectCard = parseCardPayload(updateCalls[0]![1] as string);
    const redirectBody = JSON.stringify(redirectCard['body']);
    assert.match(redirectBody, /Response sent below due to card limits/i);
  });

  it('updates the old status card before plain-text fallback when interactive card delivery fails', async () => {
    const adapter = makeAdapter();
    const sendCalls: unknown[][] = [];
    const updateCalls: unknown[][] = [];

    (adapter as any).messagingClient = {
      sendMessage: async (...args: unknown[]) => {
        sendCalls.push(args);
        const content = args[1] as string;
        if (content.includes('"msg_type":"text"')) return { messageId: 'om_text' };
        throw new LarkApiError('card table number over limit', 400);
      },
      updateMessage: async (...args: unknown[]) => {
        updateCalls.push(args);
      },
      addReaction: async () => undefined,
    };

    (adapter as any).coordinators.set('corr-1', {
      getStatusMessageId: () => 'om_status',
      finalizeMessage: async () => {
        throw new LarkApiError('Lark update failed', 500);
      },
    });

    const result = await adapter.sendFinalReply(makeConversation(), makeReply(financeFixture(4)));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.messageId, 'om_text');
    assert.ok(sendCalls.some(call => String(call[1]).includes('"msg_type":"text"')));
    for (const call of sendCalls) {
      assert.equal(call[2], 'om_parent');
      assert.equal(call[3], true);
    }
    assert.equal(updateCalls.length, 1);
    const redirectCard = parseCardPayload(updateCalls[0]![1] as string);
    assert.match(JSON.stringify(redirectCard['body']), /Response sent below due to card limits/i);
  });
});
