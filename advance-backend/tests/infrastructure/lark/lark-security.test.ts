/**
 * Tests for src/infrastructure/channels/lark/lark-security.ts
 *
 * Three groups:
 *   A. verifyLarkWebhookRequest — HMAC-SHA256 signing-secret mode
 *   B. verifyLarkWebhookRequest — verification-token (legacy) mode
 *   C. decryptLarkEvent / maybeDecryptLarkBody — AES-256-CBC decryption
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, createCipheriv } from 'crypto';
import {
  verifyLarkWebhookRequest,
  decryptLarkEvent,
  maybeDecryptLarkBody,
} from '../../../src/infrastructure/channels/lark/lark-security.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a valid HMAC-SHA256 signature for a given payload + secret + timestamp. */
function buildSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
}

/** Encrypt a string with AES-256-CBC using the same algorithm as decryptLarkEvent. */
function encryptForLark(plaintext: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest(); // 32 bytes
  const iv  = Buffer.alloc(16, 0x42); // deterministic IV for tests (0x42 × 16)
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

// ─── A. Signing-secret mode ───────────────────────────────────────────────────

describe('verifyLarkWebhookRequest — signing-secret mode', () => {
  const SECRET  = 'super-secret-key';
  const BODY    = JSON.stringify({ event_type: 'im.message.receive_v1' });
  const TS      = '1700000000';
  const NOW_MS  = 1_700_000_000 * 1000; // same second as TS
  const SIG     = buildSignature(SECRET, TS, BODY);

  it('accepts a valid request', () => {
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         SIG,
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, true);
  });

  it('returns signature_required when timestamp header is missing', () => {
    const result = verifyLarkWebhookRequest(
      {
        headers: { 'x-lark-signature': SIG },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'signature_required');
  });

  it('returns signature_required when signature header is missing', () => {
    const result = verifyLarkWebhookRequest(
      {
        headers: { 'x-lark-request-timestamp': TS },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'signature_required');
  });

  it('returns invalid_timestamp for non-numeric timestamp', () => {
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': 'not-a-number',
          'x-lark-signature':         SIG,
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_timestamp');
  });

  it('returns replay_window_exceeded when request is too old (default 300s)', () => {
    const oldNow = (Number(TS) + 301) * 1000; // 301 seconds later
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         SIG,
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => oldNow },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'replay_window_exceeded');
  });

  it('returns replay_window_exceeded when request is from the future (> maxSkew)', () => {
    const futureNow = (Number(TS) - 301) * 1000; // 301 seconds before TS
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         SIG,
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => futureNow },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'replay_window_exceeded');
  });

  it('accepts a request exactly at maxSkewSeconds boundary', () => {
    const boundaryNow = (Number(TS) + 300) * 1000; // exactly 300s later
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         SIG,
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => boundaryNow },
    );
    assert.equal(result.ok, true);
  });

  it('respects custom maxSkewSeconds', () => {
    const slowNow = (Number(TS) + 60) * 1000; // 60s later
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         SIG,
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => slowNow, maxSkewSeconds: 30 },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'replay_window_exceeded');
  });

  it('returns invalid_signature when signature does not match', () => {
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         'deadbeef'.repeat(8), // wrong sig
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_signature');
  });

  it('returns invalid_signature when raw body was modified', () => {
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         SIG,
        },
        rawBody: BODY + ' ', // tampered body
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_signature');
  });

  it('comparison is case-insensitive for hex signature (signature lowercased)', () => {
    const upperSig = SIG.toUpperCase();
    // verifyLarkWebhookRequest lowercases the incoming signature; upperSig should still match
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': TS,
          'x-lark-signature':         upperSig,
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, true);
  });

  it('accepts array-form headers (takes first value)', () => {
    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': [TS, '9999999999'],
          'x-lark-signature':         [SIG, 'ignore_this'],
        },
        rawBody: BODY,
      },
      { signingSecret: SECRET, now: () => NOW_MS },
    );
    assert.equal(result.ok, true);
  });
});

// ─── B. Verification-token mode ───────────────────────────────────────────────

describe('verifyLarkWebhookRequest — verification-token mode', () => {
  const TOKEN = 'my-lark-token-abc123';

  const bodyWithToken = { token: TOKEN, type: 'event_callback' };
  const bodyWithHeaderToken = { header: { token: TOKEN }, event: {} };

  it('accepts a matching token in body.token', () => {
    const result = verifyLarkWebhookRequest(
      { headers: {}, rawBody: '', parsedBody: bodyWithToken },
      { verificationToken: TOKEN },
    );
    assert.equal(result.ok, true);
  });

  it('accepts a matching token in body.header.token', () => {
    const result = verifyLarkWebhookRequest(
      { headers: {}, rawBody: '', parsedBody: bodyWithHeaderToken },
      { verificationToken: TOKEN },
    );
    assert.equal(result.ok, true);
  });

  it('returns missing_verification_token when no token in body', () => {
    const result = verifyLarkWebhookRequest(
      { headers: {}, rawBody: '', parsedBody: { type: 'event_callback' } },
      { verificationToken: TOKEN },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_verification_token');
  });

  it('returns missing_verification_token when parsedBody is null', () => {
    const result = verifyLarkWebhookRequest(
      { headers: {}, rawBody: '', parsedBody: null },
      { verificationToken: TOKEN },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_verification_token');
  });

  it('returns invalid_verification_token when token does not match', () => {
    const result = verifyLarkWebhookRequest(
      { headers: {}, rawBody: '', parsedBody: { token: 'wrong-token' } },
      { verificationToken: TOKEN },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_verification_token');
  });

  it('trims whitespace from token in body', () => {
    // readBodyToken does .trim(); padded token should still match
    const result = verifyLarkWebhookRequest(
      { headers: {}, rawBody: '', parsedBody: { token: `  ${TOKEN}  ` } },
      { verificationToken: TOKEN },
    );
    assert.equal(result.ok, true);
  });
});

// ─── C. No security config ───────────────────────────────────────────────────

describe('verifyLarkWebhookRequest — no config', () => {
  it('returns missing_verification_config when neither secret nor token is set', () => {
    const result = verifyLarkWebhookRequest(
      { headers: {}, rawBody: '{}', parsedBody: {} },
      {},
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_verification_config');
  });

  it('signing-secret takes priority over verification-token when both present', () => {
    const secret = 'signing-secret';
    const body   = '{"hello":"world"}';
    const ts     = '1700000000';
    const nowMs  = 1_700_000_000 * 1000;
    const sig    = buildSignature(secret, ts, body);

    const result = verifyLarkWebhookRequest(
      {
        headers: {
          'x-lark-request-timestamp': ts,
          'x-lark-signature':         sig,
        },
        rawBody:    body,
        parsedBody: { token: 'wrong-but-irrelevant' },
      },
      {
        signingSecret:     secret,
        verificationToken: 'some-token',
        now: () => nowMs,
      },
    );
    assert.equal(result.ok, true); // signed correctly → ok even though token wrong
  });
});

// ─── D. AES-256-CBC decryption ───────────────────────────────────────────────

describe('decryptLarkEvent', () => {
  const ENCRYPT_KEY = 'my-lark-encrypt-key-for-testing';
  const PLAINTEXT   = JSON.stringify({
    header: { event_type: 'im.message.receive_v1' },
    event:  { message: { text: 'hello from encrypted payload' } },
  });

  it('decrypts a payload encrypted with the matching key', () => {
    const encrypted = encryptForLark(PLAINTEXT, ENCRYPT_KEY);
    const decrypted = decryptLarkEvent(encrypted, ENCRYPT_KEY);
    assert.equal(decrypted, PLAINTEXT);
  });

  it('throws on wrong key', () => {
    const encrypted = encryptForLark(PLAINTEXT, ENCRYPT_KEY);
    assert.throws(
      () => decryptLarkEvent(encrypted, 'wrong-key'),
      /Error/,
    );
  });

  it('throws on truncated ciphertext (too short to contain IV)', () => {
    // base64 of 8 bytes — too short for a 16-byte IV
    const tooShort = Buffer.alloc(8, 0xAA).toString('base64');
    assert.throws(
      () => decryptLarkEvent(tooShort, ENCRYPT_KEY),
      /too short/,
    );
  });

  it('round-trips: encrypted JSON can be parsed after decryption', () => {
    const payload   = { header: { event_type: 'im.message.receive_v1' }, event: {} };
    const encrypted = encryptForLark(JSON.stringify(payload), ENCRYPT_KEY);
    const decrypted = decryptLarkEvent(encrypted, ENCRYPT_KEY);
    const parsed    = JSON.parse(decrypted) as typeof payload;
    assert.equal(parsed.header.event_type, 'im.message.receive_v1');
  });
});

// ─── E. maybeDecryptLarkBody ──────────────────────────────────────────────────

describe('maybeDecryptLarkBody', () => {
  const KEY  = 'another-encrypt-key';
  const DATA = { header: { event_type: 'im.message.receive_v1' }, event: {} };

  it('returns body unchanged when encryptKey is undefined', () => {
    const body = { foo: 'bar' };
    const result = maybeDecryptLarkBody(body, undefined);
    assert.deepEqual(result, body);
  });

  it('returns body unchanged when no encrypt field', () => {
    const body = { header: { event_type: 'im.message.receive_v1' } };
    const result = maybeDecryptLarkBody(body, KEY);
    assert.deepEqual(result, body);
  });

  it('decrypts and parses when encrypt field is present', () => {
    const encrypted = encryptForLark(JSON.stringify(DATA), KEY);
    const body      = { encrypt: encrypted };
    const result    = maybeDecryptLarkBody(body, KEY) as typeof DATA;
    assert.equal(result.header.event_type, 'im.message.receive_v1');
  });

  it('returns body unchanged when body is null', () => {
    const result = maybeDecryptLarkBody(null, KEY);
    assert.equal(result, null);
  });

  it('returns body unchanged when body is a primitive string', () => {
    const result = maybeDecryptLarkBody('raw string', KEY);
    assert.equal(result, 'raw string');
  });

  it('throws when encrypt field is present but key is wrong', () => {
    const encrypted = encryptForLark(JSON.stringify(DATA), KEY);
    const body      = { encrypt: encrypted };
    assert.throws(() => maybeDecryptLarkBody(body, 'bad-key'));
  });
});
