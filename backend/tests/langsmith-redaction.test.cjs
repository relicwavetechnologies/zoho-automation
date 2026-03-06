const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { sanitizeTraceMeta } = require('../dist/company/observability/tracing/trace-redaction');

test('sanitizeTraceMeta redacts secret-like keys and excludes raw content fields', () => {
  const sanitized = sanitizeTraceMeta({
    api_key: 'abc',
    nested: {
      authToken: 'xyz',
      password: 'pw',
      text: 'raw user message',
      prompt_body: 'full prompt',
      safe: 'ok',
    },
    content: 'raw response',
    summary: 'safe summary',
  });

  assert.equal(sanitized.api_key, '[REDACTED]');
  assert.equal(sanitized.nested.authToken, '[REDACTED]');
  assert.equal(sanitized.nested.password, '[REDACTED]');
  assert.equal(sanitized.nested.text, '[EXCLUDED]');
  assert.equal(sanitized.nested.prompt_body, '[EXCLUDED]');
  assert.equal(sanitized.content, '[EXCLUDED]');
  assert.equal(sanitized.summary, 'safe summary');
  assert.equal(sanitized.nested.safe, 'ok');
});

