const assert = require('node:assert/strict');
const test = require('node:test');

const {
  encryptZohoSecret,
  decryptZohoSecret,
} = require('../dist/company/integrations/zoho/zoho-token.crypto');
const { ZohoIntegrationError } = require('../dist/company/integrations/zoho/zoho.errors');

test('encrypt/decrypt Zoho secret roundtrip works with explicit key override', () => {
  const key = 'base64:' + Buffer.alloc(32, 7).toString('base64');
  const encrypted = encryptZohoSecret('refresh-token-123', key);

  assert.equal(encrypted.version, 1);
  assert.ok(typeof encrypted.cipherText === 'string' && encrypted.cipherText.startsWith('v1:'));

  const decrypted = decryptZohoSecret(encrypted.cipherText, key);
  assert.equal(decrypted, 'refresh-token-123');
});

test('decryptZohoSecret rejects invalid payload shape', () => {
  const key = 'base64:' + Buffer.alloc(32, 1).toString('base64');
  assert.throws(
    () => decryptZohoSecret('bad-payload', key),
    (error) => {
      assert.ok(error instanceof ZohoIntegrationError);
      assert.equal(error.code, 'schema_mismatch');
      return true;
    },
  );
});

test('encryptZohoSecret rejects invalid key material length', () => {
  assert.throws(
    () => encryptZohoSecret('token', 'base64:abcd'),
    (error) => {
      assert.ok(error instanceof ZohoIntegrationError);
      assert.equal(error.code, 'auth_failed');
      return true;
    },
  );
});
