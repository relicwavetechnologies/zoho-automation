import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProductionEnv,
  type TypedEnv,
} from '../../src/config/env.ts';

const production = (overrides: Partial<TypedEnv> = {}): TypedEnv => ({
  NODE_ENV: 'production',
  KNOWLEDGE_FILE_MALWARE_SCAN_MODE: 'required',
  ADMIN_JWT_SECRET: 'admin-'.padEnd(40, 'a'),
  MEMBER_JWT_SECRET: 'member-'.padEnd(40, 'b'),
  LARK_WEBHOOK_SIGNING_SECRET: 'lark-signing-secret',
  LARK_ENCRYPT_KEY: undefined,
  LARK_VERIFICATION_TOKEN: undefined,
  PI_LARK_CONTROLLER_URL: 'http://divo-pi-controller:4317',
  HINDSIGHT_ENABLED: true,
  HINDSIGHT_API_KEY: 'private-hindsight-key',
  OPENROUTER_API_KEY: 'private-openrouter-key',
  CLOUDINARY_CLOUD_NAME: 'private-cloud',
  CLOUDINARY_API_KEY: 'private-key',
  CLOUDINARY_API_SECRET: 'private-secret',
  ...overrides,
} as TypedEnv);

describe('production environment safety', () => {
  it('accepts a separated private production topology', () => {
    assert.deepEqual(validateProductionEnv(production()), []);
  });

  it('rejects bypassed scanning, dev JWTs, loopback controller, and partial storage credentials', () => {
    const issues = validateProductionEnv(production({
      KNOWLEDGE_FILE_MALWARE_SCAN_MODE: 'disabled',
      ADMIN_JWT_SECRET: 'dev-secret-change-me',
      MEMBER_JWT_SECRET: 'dev-secret-change-me',
      LARK_WEBHOOK_SIGNING_SECRET: undefined,
      PI_LARK_CONTROLLER_URL: 'http://127.0.0.1:4317',
      HINDSIGHT_API_KEY: undefined,
      CLOUDINARY_API_SECRET: undefined,
    }));
    assert.equal(issues.length, 8);
    assert.ok(issues.some(issue => issue.includes('MALWARE_SCAN_MODE')));
    assert.ok(issues.some(issue => issue.includes('different')));
    assert.ok(issues.some(issue => issue.includes('Lark webhook')));
    assert.ok(issues.some(issue => issue.includes('controller')));
    assert.ok(issues.some(issue => issue.includes('Hindsight')));
    assert.ok(issues.some(issue => issue.includes('Cloudinary')));
  });

  it('does not impose production-only topology checks in local test mode', () => {
    assert.deepEqual(validateProductionEnv(production({ NODE_ENV: 'test' })), []);
  });
});
