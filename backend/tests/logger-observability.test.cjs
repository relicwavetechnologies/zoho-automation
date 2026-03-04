const assert = require('node:assert/strict');
const test = require('node:test');

const { __test__ } = require('../dist/utils/logger');
const config = require('../dist/config').default;

test('logger sanitize redacts sensitive keys recursively', () => {
  const payload = {
    token: 'abc',
    authorization: 'Bearer foo',
    nested: {
      password: 'secret',
      api_key: 'k1',
      safe: 'visible',
    },
    items: [{ cookie: 'cookie-data' }, { name: 'ok' }],
  };

  const sanitized = __test__.sanitize(payload);

  assert.equal(sanitized.token, '[REDACTED]');
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.nested.password, '[REDACTED]');
  assert.equal(sanitized.nested.api_key, '[REDACTED]');
  assert.equal(sanitized.nested.safe, 'visible');
  assert.equal(sanitized.items[0].cookie, '[REDACTED]');
  assert.equal(sanitized.items[1].name, 'ok');
});

test('logger clampSampleRate enforces [0,1] bounds', () => {
  assert.equal(__test__.clampSampleRate(-1), 0);
  assert.equal(__test__.clampSampleRate(2), 1);
  assert.equal(__test__.clampSampleRate(0.25), 0.25);
  assert.equal(__test__.clampSampleRate(Number.NaN), 1);
});

test('logger shouldLog supports deterministic sampling via injected random function', () => {
  assert.equal(__test__.shouldLog('info', { sampleRate: 0.5 }, () => 0.1), true);
  assert.equal(__test__.shouldLog('info', { sampleRate: 0.5 }, () => 0.9), false);
  assert.equal(__test__.shouldLog('warn', { sampleRate: 0 }, () => 0.1), false);
  assert.equal(__test__.shouldLog('error', { sampleRate: 0, always: true }, () => 0.9), true);
});

test('logger sanitize serializes Error with stack when LOG_INCLUDE_STACK=true', () => {
  const err = new Error('boom');
  const sanitized = __test__.sanitize({ error: err });

  assert.equal(sanitized.error.name, 'Error');
  assert.equal(sanitized.error.message, 'boom');
  if (config.LOG_INCLUDE_STACK) {
    assert.equal(typeof sanitized.error.stack, 'string');
  }
});
