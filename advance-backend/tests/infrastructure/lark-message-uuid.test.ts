import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { larkMessageUuid } from '../../src/infrastructure/channels/lark/clients/lark-messaging.client.ts';
import { mailDeliveryIdempotencyKey } from '../../src/application/mail-ops/mail-ops.types.ts';

/**
 * Lark documents `uuid` as "the max len is 50" and enforces it before it looks
 * at anything else, refusing the whole request with
 * `99992402 field validation failed`.
 */
const LARK_LIMIT = 50;

describe('larkMessageUuid', () => {
  it('fits the key Mail Ops actually generates', () => {
    // The bug this exists for: `mail:` plus a sha256 is sixty-nine characters,
    // so every Lark delivery a mail rule ever attempted was refused outright
    // — five times each, from the feature's first day. Verified against the
    // live API before it was fixed, not inferred.
    const key = mailDeliveryIdempotencyKey('rule-1', 'event-1');
    assert.ok(key.length > LARK_LIMIT, 'the key this guards against got shorter');
    assert.ok(larkMessageUuid(key).length <= LARK_LIMIT);
  });

  it('is stable, so a retry de-duplicates against the attempt before it', () => {
    // The only reason to send a uuid at all. A uuid that varied per attempt
    // would turn every retry of a delivery into a second message in the chat.
    const key = mailDeliveryIdempotencyKey('rule-1', 'event-1');
    assert.equal(larkMessageUuid(key), larkMessageUuid(key));
  });

  it('keeps two different deliveries apart', () => {
    assert.notEqual(
      larkMessageUuid(mailDeliveryIdempotencyKey('rule-1', 'event-1')),
      larkMessageUuid(mailDeliveryIdempotencyKey('rule-1', 'event-2')),
    );
  });

  it('leaves a key Lark would already accept exactly as it is', () => {
    // Callers that were within the limit were never broken, and their
    // de-duplication must not silently start keying on something else.
    const short = 'run:abc-123';
    assert.equal(larkMessageUuid(short), short);
    const exact = 'a'.repeat(LARK_LIMIT);
    assert.equal(larkMessageUuid(exact), exact);
    assert.equal(larkMessageUuid('a'.repeat(LARK_LIMIT + 1)).length, LARK_LIMIT);
  });
});
