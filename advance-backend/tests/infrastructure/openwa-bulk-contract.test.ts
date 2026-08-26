import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenWaClient } from '../../src/infrastructure/whatsapp/openwa.client';

/**
 * The gateway's wire format, pinned.
 *
 * Every bug this integration has produced so far lived here rather than in the
 * logic: `{id, name}` where the gateway takes `{name}`, `.qr` where it sends
 * `qrCode`, `{phone}` where it wants `{phoneNumber}`. None of those were visible
 * in a type — the adapter compiled perfectly and failed against the real thing.
 *
 * So these tests assert on the bytes: the exact path, the exact property names,
 * the exact shape of the body. They are checked against `openwa-gateway/
 * openapi.json`, which is the authoritative contract — the README disagrees with
 * it in two places.
 */

interface Captured {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

let captured: Captured[] = [];
let respond: (call: Captured) => { status: number; body: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  captured = [];
  respond = () => ({ status: 200, body: {} });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call: Captured = {
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    captured.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const client = () => new OpenWaClient({
  baseUrl: 'http://gateway:2785',
  apiKey: 'test-key',
  publicUrl: 'http://divo:8000',
});

describe('sendBulk', () => {
  it('posts to the documented path with the session in it', async () => {
    respond = () => ({ status: 202, body: { batchId: 'b1', status: 'pending', totalMessages: 2 } });
    await client().sendBulk('sess-1', {
      batchId: 'divo_abc',
      delayMs: 3000,
      messages: [
        { chatId: '919845010001@c.us', text: 'Hi Ritu' },
        { chatId: '1203630@g.us', text: 'Hi Sangeet' },
      ],
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.method, 'POST');
    assert.equal(captured[0]!.url, 'http://gateway:2785/api/sessions/sess-1/messages/send-bulk');
  });

  /**
   * `SendBulkMessageDto` nests the text under `content`, and the item carries a
   * `type` discriminator. A flat `{chatId, text}` — which is what `send-text`
   * takes — is rejected by the whole request, not just that item, because the
   * gateway validates with `forbidNonWhitelisted`.
   */
  it('wraps each message in the batch item shape the gateway validates', async () => {
    respond = () => ({ status: 202, body: { batchId: 'b1', status: 'pending', totalMessages: 1 } });
    await client().sendBulk('sess-1', {
      batchId: 'divo_abc',
      delayMs: 3000,
      messages: [{ chatId: '919845010001@c.us', text: 'Hi Ritu' }],
    });

    const body = captured[0]!.body as {
      batchId: string;
      messages: { chatId: string; type: string; content: { text: string } }[];
      options: Record<string, unknown>;
    };
    assert.equal(body.batchId, 'divo_abc');
    assert.deepEqual(body.messages, [{
      chatId: '919845010001@c.us',
      type: 'text',
      content: { text: 'Hi Ritu' },
    }]);
  });

  /**
   * `stopOnError: false` is the load-bearing one. Left true, a single
   * unreachable number abandons the other ninety-nine and there is no way to
   * tell that from a gateway failure.
   */
  it('sends pacing options, and never stops the batch on one bad recipient', async () => {
    respond = () => ({ status: 202, body: { batchId: 'b1', status: 'pending', totalMessages: 1 } });
    await client().sendBulk('sess-1', {
      batchId: 'divo_abc',
      delayMs: 4500,
      messages: [{ chatId: '919845010001@c.us', text: 'Hi' }],
    });

    const body = captured[0]!.body as { options: Record<string, unknown> };
    assert.deepEqual(body.options, {
      delayBetweenMessages: 4500,
      randomizeDelay: true,
      stopOnError: false,
    });
  });

  it('authenticates with the header the gateway checks', async () => {
    respond = () => ({ status: 202, body: { batchId: 'b1', status: 'pending', totalMessages: 1 } });
    await client().sendBulk('sess-1', {
      batchId: 'divo_abc', delayMs: 3000,
      messages: [{ chatId: '919845010001@c.us', text: 'Hi' }],
    });
    assert.equal(captured[0]!.headers['X-API-Key'], 'test-key');
  });

  it('surfaces a rejected batch as a failure rather than a silent success', async () => {
    respond = () => ({ status: 400, body: { message: ["Batch ID 'divo_abc' already exists"] } });
    const result = await client().sendBulk('sess-1', {
      batchId: 'divo_abc', delayMs: 3000,
      messages: [{ chatId: '919845010001@c.us', text: 'Hi' }],
    });
    assert.equal(result.ok, false);
  });
});

describe('batchStatus', () => {
  it('reads the documented path', async () => {
    respond = () => ({
      status: 200,
      body: {
        batchId: 'divo_abc',
        status: 'processing',
        progress: { total: 2, sent: 1, failed: 0, pending: 1, cancelled: 0 },
        results: [{ chatId: '919845010001@c.us', status: 'sent', messageId: 'true_x' }],
      },
    });
    const result = await client().batchStatus('sess-1', 'divo_abc');

    assert.equal(
      captured[0]!.url,
      'http://gateway:2785/api/sessions/sess-1/messages/batch/divo_abc',
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.progress.sent, 1);
  });

  it('url-encodes a batch id, so an odd one cannot reshape the path', async () => {
    respond = () => ({ status: 404, body: {} });
    await client().batchStatus('sess-1', 'a/b?c');
    assert.ok(captured[0]!.url.endsWith('/messages/batch/a%2Fb%3Fc'));
  });
});

describe('cancelBatch', () => {
  it('posts to the cancel path', async () => {
    respond = () => ({ status: 200, body: { batchId: 'divo_abc', status: 'cancelled' } });
    const result = await client().cancelBatch('sess-1', 'divo_abc');

    assert.equal(captured[0]!.method, 'POST');
    assert.equal(
      captured[0]!.url,
      'http://gateway:2785/api/sessions/sess-1/messages/batch/divo_abc/cancel',
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.alreadyFinished, undefined);
  });

  /**
   * The gateway answers 400 when the batch is already terminal. The caller asked
   * for it to stop and it has stopped, so that is not a failure — but it is
   * reported, because "stopped it" and "it had already finished" mean different
   * things to whoever pressed the button.
   */
  it('reads a 400 about a finished batch as success, flagged', async () => {
    respond = () => ({
      status: 400,
      body: { message: 'Batch already completed, cancelled, or failed' },
    });
    const result = await client().cancelBatch('sess-1', 'divo_abc');

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.alreadyFinished, true);
  });

  /** The other half of that translation: a real 400 must still fail. */
  it('still fails on a 400 that means something else', async () => {
    respond = () => ({ status: 400, body: { message: 'Session is not active' } });
    const result = await client().cancelBatch('sess-1', 'divo_abc');
    assert.equal(result.ok, false);
  });

  it('does not swallow a 404 for a batch the gateway has forgotten', async () => {
    respond = () => ({ status: 404, body: { message: 'Batch not found' } });
    const result = await client().cancelBatch('sess-1', 'divo_abc');
    assert.equal(result.ok, false);
  });
});

describe('checkNumber', () => {
  /**
   * The gateway's path takes bare digits. Divo stores and displays E.164, and
   * this adapter is the one place that knows the two differ — the same rule
   * `pairingCode` follows for `phoneNumber`.
   */
  it('strips the plus and any formatting before asking', async () => {
    respond = () => ({ status: 200, body: { exists: true, chatId: '919845010001@c.us' } });
    await client().checkNumber('sess-1', '+91 98450 10001');

    assert.equal(
      captured[0]!.url,
      'http://gateway:2785/api/sessions/sess-1/contacts/check/919845010001',
    );
  });

  it('reports a number that is not registered', async () => {
    respond = () => ({ status: 200, body: { exists: false } });
    const result = await client().checkNumber('sess-1', '+919999999999');
    assert.equal(result.ok && result.value.exists, false);
  });

  /**
   * The gateway answers 503 for "WhatsApp did not answer the lookup", precisely
   * so it is not mistaken for "this number does not exist". It must reach the
   * caller as a failure — read as `exists: false`, a real client would be
   * silently dropped from a send because a lookup timed out.
   */
  it('fails rather than reporting a non-existent number when the lookup breaks', async () => {
    respond = () => ({ status: 503, body: { message: 'WhatsApp did not answer' } });
    const result = await client().checkNumber('sess-1', '+919845010001');
    assert.equal(result.ok, false);
  });
});

describe('the outbound surface', () => {
  /**
   * There is deliberately no single-message send on this client. Divo has one
   * reason to write to WhatsApp — a broadcast a person composed and had
   * reviewed — and a convenient `sendText` sitting beside it is how "the
   * follow-up agent never replies" quietly stops being true.
   */
  it('exposes no way to send one unreviewed message', () => {
    assert.equal('sendText' in client(), false);
  });
});
