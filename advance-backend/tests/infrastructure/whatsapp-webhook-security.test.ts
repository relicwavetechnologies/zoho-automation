import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyWhatsappSignature } from '../../src/infrastructure/whatsapp/whatsapp-webhook.security.ts';

const SECRET = 'a-shared-secret';
const sign = (body: string, secret = SECRET) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

describe('verifyWhatsappSignature', () => {
  const body = JSON.stringify({ event: 'message.received', data: { id: 'wa-1' } });

  it('accepts a signature over the exact bytes', () => {
    assert.equal(verifyWhatsappSignature(body, sign(body), SECRET), true);
  });

  it('accepts the same body as a Buffer', () => {
    assert.equal(verifyWhatsappSignature(Buffer.from(body, 'utf8'), sign(body), SECRET), true);
  });

  it('rejects a body that changed by one character', () => {
    // The whole reason the raw body is captured rather than re-serialised: a
    // re-encoded object can differ in key order or spacing and still be "equal".
    assert.equal(verifyWhatsappSignature(`${body} `, sign(body), SECRET), false);
  });

  it('rejects a signature made with a different secret', () => {
    assert.equal(verifyWhatsappSignature(body, sign(body, 'wrong'), SECRET), false);
  });

  it('rejects a missing header when a secret is configured', () => {
    assert.equal(verifyWhatsappSignature(body, undefined, SECRET), false);
  });

  it('does not throw on a malformed header of the wrong length', () => {
    // timingSafeEqual throws on length mismatch, so the length guard is what
    // keeps a junk header a rejection instead of a 500.
    assert.doesNotThrow(() => verifyWhatsappSignature(body, 'sha256=short', SECRET));
    assert.equal(verifyWhatsappSignature(body, 'sha256=short', SECRET), false);
    assert.equal(verifyWhatsappSignature(body, '', SECRET), false);
  });

  it('skips verification when no secret is configured', () => {
    assert.equal(verifyWhatsappSignature(body, undefined, undefined), true);
  });
});
