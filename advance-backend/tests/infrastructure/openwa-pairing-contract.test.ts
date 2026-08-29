import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { OpenWaClient } from '../../src/infrastructure/whatsapp/openwa.client.ts';

/**
 * The gateway's QR endpoint, including the success it reports as a failure.
 *
 * Once a handset finishes scanning there is no QR left to hand out, and the
 * gateway answers `400 "Session is already authenticated, no QR code needed"`.
 * Read as a plain HTTP failure it reaches the link dialog as "the gateway did
 * not answer" — the opposite of the truth, at the one moment somebody is
 * staring at the screen to find out whether their scan worked.
 */

const client = () => new OpenWaClient({
  baseUrl: 'http://gateway.test',
  apiKey: 'k',
  publicUrl: 'http://divo.test',
});

const respond = (status: number, body: unknown) => {
  mock.method(globalThis, 'fetch', async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  ));
};

describe('pairing', () => {
  it('reads a QR from the gateway field name it actually uses', async () => {
    // `qrCode`, not `qr`. Reading the wrong one returns undefined rather than
    // failing, so the dialog waits for a code that already arrived.
    respond(200, { qrCode: 'data:image/png;base64,AAA=', status: 'qr_ready' });
    const result = await client().pairing('s-1');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.qrCode, 'data:image/png;base64,AAA=');
    mock.restoreAll();
  });

  it('treats "already authenticated" as linked, not as an outage', async () => {
    respond(400, {
      message: 'Session is already authenticated, no QR code needed',
      error: 'Bad Request',
      statusCode: 400,
    });
    const result = await client().pairing('s-1');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.status, 'ready');
    assert.equal(result.ok && result.value.qrCode, undefined);
    mock.restoreAll();
  });

  it('still fails on a 400 that means something else', async () => {
    // Matched on status *and* message. Reporting every 400 as a linked handset
    // would be the same silent-success bug pointing the other way.
    respond(400, { message: 'sessionId must be a UUID', statusCode: 400 });
    const result = await client().pairing('not-a-uuid');
    assert.equal(result.ok, false);
    mock.restoreAll();
  });

  it('still fails when the gateway is genuinely down', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED'); });
    const result = await client().pairing('s-1');
    assert.equal(result.ok, false);
    mock.restoreAll();
  });
});

/**
 * Creating a session on a gateway that starts sessions for you.
 *
 * Divo runs the gateway with `AUTO_START_SESSIONS`, so by the time the start
 * call lands the engine is already up and the gateway answers
 * `400 Session is already started`. Reading that as a failure is what made the
 * link dialog say "Divo could not confirm whether the number finished
 * provisioning" on the first attempt every single time, while the gateway's own
 * log recorded the session as created — four sessions built and abandoned
 * before one stuck.
 */
describe('creating a session', () => {
  const sequence = (responses: { status: number; body: unknown }[]) => {
    let call = 0;
    mock.method(globalThis, 'fetch', async () => {
      const next = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    });
  };

  it('treats "already started" as the session being up, not as a failure', async () => {
    sequence([
      { status: 201, body: { id: 's-9', name: 'divo-dept-hash-desk', status: 'created' } },
      { status: 400, body: { message: 'Session is already started', error: 'Bad Request', statusCode: 400 } },
    ]);
    const result = await client().createSession('divo-dept-hash-desk');
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.id, 's-9');
    mock.restoreAll();
  });

  it('still fails on a 400 that is not the benign one', async () => {
    // The tolerance is for one exact gateway answer. A rejected id or a
    // malformed body must still surface, or this becomes a blanket swallow.
    sequence([
      { status: 201, body: { id: 's-9', name: 'divo-dept-hash-desk', status: 'created' } },
      { status: 400, body: { message: 'property id should not exist', error: 'Bad Request', statusCode: 400 } },
    ]);
    const result = await client().createSession('divo-dept-hash-desk');
    assert.equal(result.ok, false);
    mock.restoreAll();
  });
});

/**
 * Reading a chat's past.
 *
 * The gateway keeps its own store of everything it has seen, including what
 * Baileys backfills on link. The engine-specific `/history` call answers 501,
 * so a repair pointed at it recovered nothing while the messages sat there —
 * these pin the endpoint and, more importantly, the identity of a message.
 */
describe('chat history', () => {
  const respondJson = (body: unknown) => {
    mock.method(globalThis, 'fetch', async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
  };
  let calls: string[] = [];

  it('reads the store, not the engine call that is unimplemented', async () => {
    calls = [];
    respondJson({ messages: [], total: 0 });
    await client().chatHistory('s-1', '9199@c.us', 10);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes('/sessions/s-1/messages?chatId='), calls[0]);
    assert.equal(calls[0]!.includes('/history'), false);
    mock.restoreAll();
  });

  it('carries the WhatsApp message id, never the store row id', async () => {
    // The unique key the webhook path writes through is the WhatsApp id. Using
    // the row's own primary key would re-insert every message already stored.
    calls = [];
    respondJson({
      messages: [{
        id: 'b0f1c2d3-0000-4444-8888-99990000aaaa',
        waMessageId: '3EB0A1B2C3D4E5F60718',
        chatId: '9199@c.us',
        direction: 'incoming',
        author: '9199@c.us',
        body: 'hi',
        type: 'text',
        timestamp: 1787989242,
        chatName: 'Venue',
        metadata: { quotedMessage: { body: 'earlier' } },
      }],
      total: 1,
    });
    const result = await client().chatHistory('s-1', '9199@c.us', 10);
    assert.equal(result.ok, true);
    const payload = result.ok ? result.value[0]! : {};
    assert.equal(payload['id'], '3EB0A1B2C3D4E5F60718');
    assert.equal(payload['fromMe'], false);
    assert.equal(payload['isGroup'], false);
    assert.equal(payload['timestamp'], 1787989242);
    mock.restoreAll();
  });

  it('reads group-ness from the chat id, which the store does not carry', async () => {
    calls = [];
    respondJson({
      messages: [{
        id: 'row-2', waMessageId: 'W2', chatId: '12036@g.us',
        direction: 'outgoing', author: '9199@c.us', body: 'ok',
        type: 'text', timestamp: 1787989242,
      }],
      total: 1,
    });
    const result = await client().chatHistory('s-1', '12036@g.us', 10);
    const payload = result.ok ? result.value[0]! : {};
    assert.equal(payload['isGroup'], true);
    assert.equal(payload['fromMe'], true);
    mock.restoreAll();
  });
});
