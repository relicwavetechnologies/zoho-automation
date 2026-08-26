import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeWhatsappEnvelope } from '../../src/application/whatsapp/whatsapp-message.normalize.ts';

const envelope = (data: Record<string, unknown>, event = 'message.received') => ({
  event,
  sessionId: 'divo-abc-bookings-x1',
  data,
});

describe('normalizeWhatsappEnvelope', () => {
  it('reads an inbound direct message and trusts the contact name', () => {
    const result = normalizeWhatsappEnvelope(envelope({
      id: 'wa-1',
      from: '919876543210@c.us',
      fromMe: false,
      body: 'Can you send the quote today?',
      timestamp: 1_700_000_000,
      contact: { name: 'Priya' },
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message.waChatId, '919876543210@c.us');
    assert.equal(result.message.senderName, 'Priya');
    assert.equal(result.message.fromMe, false);
    // An inbound DM is the one payload that names the counterpart, so it is the
    // one payload allowed to set the chat name.
    assert.equal(result.message.chatName, 'Priya');
    assert.equal(result.message.occurredAt.getTime(), 1_700_000_000_000);
  });

  it('leaves the chat name empty for an outbound direct message', () => {
    // The name on an outbound payload is ours, not theirs. Writing it would
    // rename the customer's chat after ourselves.
    const result = normalizeWhatsappEnvelope(envelope({
      id: 'wa-2',
      to: '919876543210@c.us',
      fromMe: true,
      body: 'Sending it now',
      timestamp: 1_700_000_100,
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message.waChatId, '919876543210@c.us');
    assert.equal(result.message.senderName, 'You');
    assert.equal(result.message.chatName, '');
  });

  it('leaves the chat name empty for a group and prefers the author as sender', () => {
    const result = normalizeWhatsappEnvelope(envelope({
      id: 'wa-3',
      from: '120363000000@g.us',
      author: '919999999999@c.us',
      isGroup: true,
      fromMe: false,
      body: 'Venue confirmed for the 12th',
      timestamp: 1_700_000_200,
      contact: { pushName: 'Rahul' },
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message.waChatId, '120363000000@g.us');
    assert.equal(result.message.isGroup, true);
    assert.equal(result.message.senderName, 'Rahul');
    // A group payload never carries the subject; the chat-list refresh fills it.
    assert.equal(result.message.chatName, '');
  });

  it('falls back to the JID digits when no name is present', () => {
    const result = normalizeWhatsappEnvelope(envelope({
      id: 'wa-4',
      from: '919876543210:12@c.us',
      fromMe: false,
      body: 'hi',
      timestamp: 1_700_000_300,
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message.senderName, '919876543210');
  });

  it('rejects status broadcasts and channel posts', () => {
    for (const data of [
      { id: 'wa-5', from: 'status@broadcast', isStatusBroadcast: true },
      { id: 'wa-6', from: 'x@newsletter', kind: 'channel' },
      { id: 'wa-7', from: 'x@newsletter', kind: 'status' },
    ]) {
      const result = normalizeWhatsappEnvelope(envelope(data));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'not_a_conversation');
    }
  });

  it('ignores events it did not subscribe to', () => {
    const result = normalizeWhatsappEnvelope(envelope({ id: 'wa-8' }, 'session.status'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'ignored_event');
  });

  it('reports a missing id or chat as malformed rather than guessing', () => {
    const noId = normalizeWhatsappEnvelope(envelope({ from: 'x@c.us' }));
    assert.equal(noId.ok, false);
    if (!noId.ok) assert.equal(noId.reason, 'malformed');

    const noChat = normalizeWhatsappEnvelope(envelope({ id: 'wa-9', fromMe: false }));
    assert.equal(noChat.ok, false);
    if (!noChat.ok) assert.equal(noChat.reason, 'malformed');
  });

  it('uses now, not 1970, when the timestamp is unusable', () => {
    // A message stamped at the epoch falls outside every analysis window, which
    // would make it invisible rather than merely imprecise.
    const before = Date.now();
    const result = normalizeWhatsappEnvelope(envelope({
      id: 'wa-10',
      from: '919876543210@c.us',
      body: 'no stamp',
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.message.occurredAt.getTime() >= before);
  });

  it('carries the quoted message through', () => {
    const result = normalizeWhatsappEnvelope(envelope({
      id: 'wa-11',
      from: '919876543210@c.us',
      body: 'Yes, done',
      timestamp: 1_700_000_400,
      quotedMessage: { body: 'Did you send the invoice?' },
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.message.quotedText, 'Did you send the invoice?');
  });
});
