import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EnvSchema } from '../../src/config/env.ts';

const base = {
  DATABASE_URL: 'postgresql://local/test',
  REDIS_URL: 'redis://local',
  OPENAI_API_KEY: 'test-key',
  LARK_APP_ID: 'test-app',
  LARK_APP_SECRET: 'test-secret',
};

const configured = {
  ...base,
  MENHOOD_ENABLED: 'true',
  MENHOOD_DB_HOST: 'db.internal',
  MENHOOD_DB_PORT: '25432',
  MENHOOD_DB_NAME: 'menhood',
  MENHOOD_DB_USER: 'reader',
  MENHOOD_DB_PASSWORD: 'private-password',
  MENHOOD_COMPANY_ID: '9f9360aa-28d1-49df-919f-3b121b7403df',
  MENHOOD_DB_SSL_MODE: 'require',
  MENHOOD_DB_SSL_CA_BASE64: Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n').toString('base64'),
  MENHOOD_DB_SSL_SERVER_NAME: 'db.internal',
};

describe('Menhood environment', () => {
  it('stays optional while disabled', () => {
    const result = EnvSchema.safeParse({ ...base, MENHOOD_ENABLED: 'false' });
    assert.equal(result.success, true);
  });

  it('accepts a complete enabled configuration', () => {
    const result = EnvSchema.safeParse(configured);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.MENHOOD_DB_PORT, 25_432);
    assert.equal(result.data.MENHOOD_DB_SSL_MODE, 'require');
  });

  it('rejects an invalid port', () => {
    const result = EnvSchema.safeParse({ ...configured, MENHOOD_DB_PORT: '70000' });
    assert.equal(result.success, false);
  });

  it('requires the credential and company binding only when enabled', () => {
    const secret = 'must-not-appear';
    const result = EnvSchema.safeParse({
      ...configured,
      MENHOOD_DB_PASSWORD: '',
      MENHOOD_COMPANY_ID: '',
      UNUSED_SECRET_PROBE: secret,
    });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(JSON.stringify(result.error.flatten()).includes(secret), false);
    assert.ok(result.error.flatten().fieldErrors.MENHOOD_DB_PASSWORD?.length);
    assert.ok(result.error.flatten().fieldErrors.MENHOOD_COMPANY_ID?.length);
  });

  it('rejects a non-UUID company binding', () => {
    const result = EnvSchema.safeParse({ ...configured, MENHOOD_COMPANY_ID: 'relicwave' });
    assert.equal(result.success, false);
  });

  it('rejects disabled or unauthenticated TLS', () => {
    assert.equal(EnvSchema.safeParse({ ...configured, MENHOOD_DB_SSL_MODE: 'disable' }).success, false);
    assert.equal(EnvSchema.safeParse({ ...configured, MENHOOD_DB_SSL_CA_BASE64: '' }).success, false);
    assert.equal(EnvSchema.safeParse({ ...configured, MENHOOD_DB_SSL_SERVER_NAME: '' }).success, false);
    assert.equal(EnvSchema.safeParse({ ...configured, MENHOOD_DB_SSL_CA_BASE64: 'not-a-certificate' }).success, false);
  });
});
