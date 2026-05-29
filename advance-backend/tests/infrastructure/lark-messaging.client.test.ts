import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LarkToolMessagingClient } from '../../src/infrastructure/channels/lark/clients/lark-messaging.client.ts';
import { LarkApiError } from '../../src/infrastructure/channels/lark/clients/lark-http.client.ts';
import { TOKEN_RESPONSE, buildMockFetch, errorMock } from '../helpers/mock-fetch.ts';

const DEPS = { appId: 'app1', appSecret: 'secret1' };
const TOKEN_HANDLER = { match: (url: string) => url.includes('tenant_access_token'), response: TOKEN_RESPONSE };
const CHAT_ID = 'oc_abc123chat';
const MSG_ID = 'om_def456msg';

describe('LarkToolMessagingClient', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // ── sendMessage ────────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('POSTs to /im/v1/messages with receive_id_type=chat_id', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/im/v1/messages'),
          response: { code: 0, data: { message_id: 'om_new001', msg_type: 'text' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const result = await client.sendMessage(CHAT_ID, 'Hello world');

      assert.equal(result.messageId, 'om_new001');
      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/im/v1/messages'));
      assert.ok(apiCall?.url.includes('receive_id_type=chat_id'), 'should include receive_id_type');
    });

    it('sends receive_id and text content in body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/im/v1/messages'),
          response: { code: 0, data: { message_id: 'om_1' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      await client.sendMessage(CHAT_ID, 'Hello team!');

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/im/v1/messages'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body?.['receive_id'], CHAT_ID);
      assert.equal(body?.['msg_type'], 'text');
      const content = JSON.parse(body?.['content'] as string) as Record<string, unknown>;
      assert.equal(content['text'], 'Hello team!');
    });

    it('returns messageId from nested message field when message_id is absent', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/im/v1/messages'),
          response: {
            code: 0,
            data: { message: { message_id: 'om_nested_msg' } },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const result = await client.sendMessage(CHAT_ID, 'text');
      assert.equal(result.messageId, 'om_nested_msg');
    });

    it('throws LarkApiError on API error', async () => {
      globalThis.fetch = errorMock('chat not found', 230006);
      const client = new LarkToolMessagingClient(DEPS);
      await assert.rejects(() => client.sendMessage('bad-chat', 'hello'), LarkApiError);
    });
  });

  // ── replyMessage ──────────────────────────────────────────────────────────

  describe('replyMessage', () => {
    it('POSTs to /im/v1/messages/{id}/reply', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/reply'),
          response: { code: 0, data: { message_id: 'om_reply001' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const result = await client.replyMessage(MSG_ID, 'Got it!');

      assert.equal(result.messageId, 'om_reply001');
      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/reply'));
      assert.ok(apiCall?.url.includes(MSG_ID), 'URL should include original messageId');
    });

    it('sends text content in reply body', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/reply'),
          response: { code: 0, data: { message_id: 'om_r1' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      await client.replyMessage(MSG_ID, 'Acknowledged');

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/reply'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body?.['msg_type'], 'text');
      const content = JSON.parse(body?.['content'] as string) as Record<string, unknown>;
      assert.equal(content['text'], 'Acknowledged');
    });

    it('URL-encodes messageId in path', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { message_id: 'r1' } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      await client.replyMessage('msg/with/slashes', 'text');

      const apiCall = calls.find(c => c.method === 'POST' && (c.url as string).includes('/reply'));
      assert.ok(apiCall?.url.includes('msg%2Fwith%2Fslashes'), 'should URL-encode messageId');
    });

    it('throws LarkApiError on API error', async () => {
      globalThis.fetch = errorMock('message not found', 230002);
      const client = new LarkToolMessagingClient(DEPS);
      await assert.rejects(() => client.replyMessage('missing', 'hi'), LarkApiError);
    });
  });

  // ── listMessages ──────────────────────────────────────────────────────────

  describe('listMessages', () => {
    it('GETs messages and maps to normalized shape', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes('/im/v1/messages'),
          response: {
            code: 0,
            data: {
              items: [
                {
                  message_id: 'om_1',
                  body: JSON.stringify({ text: 'Hello' }),
                  sender: { id: 'uid_alice' },
                  create_time: '1700000000000',
                },
                {
                  message_id: 'om_2',
                  body: JSON.stringify({ text: 'World' }),
                  sender: { id: 'uid_bob' },
                  create_time: '1700001000000',
                },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const messages = await client.listMessages(CHAT_ID);

      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.messageId, 'om_1');
      assert.equal(messages[0]?.text, 'Hello');
      assert.equal(messages[0]?.senderId, 'uid_alice');
      assert.equal(messages[1]?.messageId, 'om_2');
    });

    it('passes page_size query param', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      await client.listMessages(CHAT_ID, 30);

      const apiCall = calls.find(c => c.url.includes('/im/v1/messages'));
      assert.ok(apiCall?.url.includes('page_size=30'), 'should pass page_size=30');
    });

    it('includes container_id in query URL', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: { items: [] } } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      await client.listMessages(CHAT_ID);

      const apiCall = calls.find(c => c.url.includes('/im/v1/messages'));
      assert.ok(apiCall?.url.includes('container_id_type=chat'), 'should have container_id_type');
      assert.ok(apiCall?.url.includes(CHAT_ID), 'should include chatId');
    });

    it('returns empty array when no items', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        { match: () => true, response: { code: 0, data: {} } },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const messages = await client.listMessages(CHAT_ID);
      assert.deepEqual(messages, []);
    });

    it('gracefully handles malformed body JSON', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: () => true,
          response: {
            code: 0,
            data: {
              items: [
                { message_id: 'om_bad', body: 'not-json', sender: { id: 'uid1' }, create_time: '1' },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const messages = await client.listMessages(CHAT_ID);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.text, '', 'should return empty string for malformed body');
    });
  });

  // ── getMessage ────────────────────────────────────────────────────────────

  describe('getMessage', () => {
    it('GETs /im/v1/messages/{id} and returns normalized message', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'GET' && url.includes(`/messages/${MSG_ID}`),
          response: {
            code: 0,
            data: {
              items: [
                {
                  message_id: MSG_ID,
                  body: JSON.stringify({ text: 'Important update' }),
                  sender: { id: 'uid_sender' },
                  create_time: '1700005000000',
                },
              ],
            },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const message = await client.getMessage(MSG_ID);

      assert.equal(message.messageId, MSG_ID);
      assert.equal(message.text, 'Important update');
      assert.equal(message.senderId, 'uid_sender');
      assert.equal(message.timestamp, '1700005000000');
    });

    it('falls back to passed-in messageId when item has no message_id', async () => {
      const { fetch } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: () => true,
          response: {
            code: 0,
            data: { items: [{ body: JSON.stringify({ text: 'hi' }), sender: { id: 'u1' }, create_time: '1' }] },
          },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const message = await client.getMessage('fallback-id');
      assert.equal(message.messageId, 'fallback-id');
    });

    it('URL-encodes messageId in path', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: () => true,
          response: { code: 0, data: { items: [{ message_id: 'x', body: '{}', sender: { id: 'u' }, create_time: '1' }] } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      await client.getMessage('msg/slash');

      const apiCall = calls.find(c => c.url.includes('/im/v1/messages/'));
      assert.ok(apiCall?.url.includes('msg%2Fslash'), 'should URL-encode messageId');
    });

    it('throws LarkApiError when message not found', async () => {
      globalThis.fetch = errorMock('message not found', 230002);
      const client = new LarkToolMessagingClient(DEPS);
      await assert.rejects(() => client.getMessage('gone'), LarkApiError);
    });
  });

  // ── sendDm ────────────────────────────────────────────────────────────────

  describe('sendDm', () => {
    it('keeps plain direct messages as text messages', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/im/v1/messages'),
          response: { code: 0, data: { message_id: 'om_dm_text' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const result = await client.sendDm('ou_user_1', 'Hello Shivam');

      assert.equal(result.messageId, 'om_dm_text');
      const apiCall = calls.find(c => c.method === 'POST' && c.url.includes('/im/v1/messages'));
      assert.ok(apiCall?.url.includes('receive_id_type=open_id'), 'should send by open_id');
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body['receive_id'], 'ou_user_1');
      assert.equal(body['msg_type'], 'text');
      assert.deepEqual(JSON.parse(body['content'] as string), { text: 'Hello Shivam' });
    });

    it('sends markdown-rich direct messages as interactive cards', async () => {
      const { fetch, calls } = buildMockFetch([
        TOKEN_HANDLER,
        {
          match: (url, m) => m === 'POST' && url.includes('/im/v1/messages'),
          response: { code: 0, data: { message_id: 'om_dm_card' } },
        },
      ]);
      globalThis.fetch = fetch;

      const client = new LarkToolMessagingClient(DEPS);
      const result = await client.sendDm(
        'ou_user_1',
        [
          '📊 **Emiac Technologies — Live NSE Update**',
          '',
          '| Source | Price |',
          '|---|---|',
          '| NSE | ₹101.30 |',
        ].join('\n'),
      );

      assert.equal(result.messageId, 'om_dm_card');
      const apiCall = calls.find(c => c.method === 'POST' && c.url.includes('/im/v1/messages'));
      const body = apiCall?.body as Record<string, unknown>;
      assert.equal(body['receive_id'], 'ou_user_1');
      assert.equal(body['msg_type'], 'interactive');
      const card = JSON.parse(body['content'] as string) as Record<string, unknown>;
      assert.equal(card['schema'], '2.0');
      assert.match(JSON.stringify(card), /table/);
      assert.match(JSON.stringify(card), /Emiac Technologies/);
    });
  });
});
