import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafePublishedMemoryFact } from '../../src/application/knowledge/knowledge-fact-safety.ts';

describe('published memory fact safety', () => {
  it('rejects explicit secret assignments without returning the secret', () => {
    for (const fact of [
      'API key: super-secret-value',
      'The password is hunter22',
      'client_secret=abcdef123456',
      'Refresh token: token-value-123',
      'token=abcdef123456',
      'secret access key: abcdef123456',
      'Private key: key-material',
    ]) {
      assert.equal(isSafePublishedMemoryFact(fact), false);
    }
  });

  it('rejects PEM private keys and well-known token prefixes', () => {
    for (const fact of [
      '-----BEGIN PRIVATE KEY-----\nabc',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc',
      'OpenAI token sk-proj-abcdefghijklmnopqrstuv',
      'GitHub token ghp_abcdefghijklmnopqrstuvwxyz',
      'Slack token xoxb-1234567890-abcdefghij',
      'AWS key AKIAABCDEFGHIJKLMNOP',
      'Google token ya29.abcdefghijklmnopqrstuvwxyz',
      'Google API key AIzaabcdefghijklmnopqrstuvwxyz123456789',
      'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
    ]) {
      assert.equal(isSafePublishedMemoryFact(fact), false);
    }
  });

  it('allows durable policy facts and redacted credential references', () => {
    for (const fact of [
      'API keys are rotated every 90 days.',
      'The finance team stores credentials in the company vault.',
      'The API key is redacted.',
      'Password reset requests go to IT.',
      'Token budgets are measured per model.',
      'The client secret is masked.',
    ]) {
      assert.equal(isSafePublishedMemoryFact(fact), true);
    }
  });
});
