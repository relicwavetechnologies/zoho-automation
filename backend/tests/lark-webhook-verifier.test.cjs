const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { verifyLarkWebhookRequest } = require('../dist/company/security/lark/lark-webhook-verifier');

const setEnv = (next) => {
  const keys = [
    'LARK_VERIFICATION_TOKEN',
    'LARK_WEBHOOK_SIGNING_SECRET',
    'LARK_WEBHOOK_MAX_SKEW_SECONDS',
  ];
  const previous = {};

  for (const key of keys) {
    previous[key] = process.env[key];
  }

  for (const key of keys) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  };
};

test('verifyLarkWebhookRequest accepts matching verification token payload', () => {
  const restore = setEnv({
    LARK_VERIFICATION_TOKEN: 'token-abc',
  });

  try {
    const result = verifyLarkWebhookRequest({
      headers: {},
      rawBody: JSON.stringify({ token: 'token-abc' }),
      parsedBody: {
        token: 'token-abc',
      },
    });

    assert.equal(result.ok, true);
  } finally {
    restore();
  }
});

test('verifyLarkWebhookRequest rejects mismatched verification token payload', () => {
  const restore = setEnv({
    LARK_VERIFICATION_TOKEN: 'token-abc',
  });

  try {
    const result = verifyLarkWebhookRequest({
      headers: {},
      rawBody: JSON.stringify({ token: 'token-wrong' }),
      parsedBody: {
        token: 'token-wrong',
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_verification_token');
  } finally {
    restore();
  }
});

test('verifyLarkWebhookRequest accepts valid signature mode', () => {
  const restore = setEnv({
    LARK_WEBHOOK_SIGNING_SECRET: 'secret-1',
    LARK_WEBHOOK_MAX_SKEW_SECONDS: '300',
  });

  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: 'event_callback' });
    const signature = crypto
      .createHmac('sha256', 'secret-1')
      .update(`${timestamp}:${rawBody}`)
      .digest('hex');

    const result = verifyLarkWebhookRequest({
      headers: {
        'x-lark-request-timestamp': timestamp,
        'x-lark-signature': signature,
      },
      rawBody,
      parsedBody: {
        type: 'event_callback',
      },
    });

    assert.equal(result.ok, true);
  } finally {
    restore();
  }
});

test('verifyLarkWebhookRequest requires config when signature headers exist but secret missing', () => {
  const restore = setEnv({});

  try {
    const result = verifyLarkWebhookRequest({
      headers: {
        'x-lark-request-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-lark-signature': 'abc',
      },
      rawBody: '{}',
      parsedBody: {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_verification_config');
  } finally {
    restore();
  }
});
