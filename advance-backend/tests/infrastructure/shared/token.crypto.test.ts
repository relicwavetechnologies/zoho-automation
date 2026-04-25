/**
 * token.crypto — unit tests
 *
 * Tests: encrypt/decrypt round-trip, wrong key, tampered data, empty values.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encryptToken, decryptToken, TokenCryptoError } from '../../../src/infrastructure/shared/token.crypto';

const KEY  = 'test-encryption-key-32bytes-pad!!';
const KEY2 = 'different-encryption-key-32bytes!!';

describe('token.crypto', () => {
  describe('encryptToken / decryptToken round-trip', () => {
    it('encrypts and decrypts a plain string', () => {
      const plain = 'my-secret-token-value';
      const { cipherText } = encryptToken(plain, KEY);
      assert.equal(decryptToken(cipherText, KEY), plain);
    });

    it('produces different ciphertext for the same input (random IV)', () => {
      const plain = 'same-value';
      const ct1 = encryptToken(plain, KEY).cipherText;
      const ct2 = encryptToken(plain, KEY).cipherText;
      assert.notEqual(ct1, ct2); // different IVs → different cipher text
    });

    it('ciphertext includes version prefix v1:', () => {
      const { cipherText, version } = encryptToken('data', KEY);
      assert(cipherText.startsWith('v1:'));
      assert.equal(version, 1);
    });

    it('decrypts with base64: key prefix', () => {
      // SHA-256(KEY) is 32 bytes; encode as base64 to form a base64: key
      const raw    = createHash('sha256').update(KEY).digest('base64');
      const b64Key = `base64:${raw}`;
      const { cipherText } = encryptToken('hello', b64Key);
      assert.equal(decryptToken(cipherText, b64Key), 'hello');
    });
  });

  describe('error cases', () => {
    it('throws TokenCryptoError when decrypting with wrong key', () => {
      const { cipherText } = encryptToken('secret', KEY);
      assert.throws(
        () => decryptToken(cipherText, KEY2),
        (e) => e instanceof TokenCryptoError,
      );
    });

    it('throws TokenCryptoError for invalid ciphertext format', () => {
      assert.throws(
        () => decryptToken('not-valid-cipher-text', KEY),
        (e) => e instanceof TokenCryptoError,
      );
    });

    it('throws TokenCryptoError when encrypting empty string', () => {
      assert.throws(
        () => encryptToken('', KEY),
        (e) => e instanceof TokenCryptoError,
      );
    });

    it('throws TokenCryptoError when decrypting tampered data', () => {
      const { cipherText } = encryptToken('data', KEY);
      // Flip last byte of the data portion
      const parts = cipherText.split(':');
      const lastPart = parts[3] ?? '';
      const tampered = parts.slice(0, 3).join(':') + ':' + lastPart.slice(0, -2) + 'aa';
      assert.throws(
        () => decryptToken(tampered, KEY),
        (e) => e instanceof TokenCryptoError,
      );
    });

    it('throws TokenCryptoError when key is empty', () => {
      assert.throws(
        () => encryptToken('data', ''),
        (e) => e instanceof TokenCryptoError,
      );
    });
  });

  describe('long token values', () => {
    it('handles long OAuth token (256 chars)', () => {
      const long = 'x'.repeat(256);
      const { cipherText } = encryptToken(long, KEY);
      assert.equal(decryptToken(cipherText, KEY), long);
    });

    it('handles unicode token content', () => {
      const unicode = '你好世界 🔑 token';
      const { cipherText } = encryptToken(unicode, KEY);
      assert.equal(decryptToken(cipherText, KEY), unicode);
    });
  });
});
