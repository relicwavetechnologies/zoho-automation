const assert = require('node:assert/strict');
const test = require('node:test');

const { EnvValidationError, validateEnvironmentContract } = require('../dist/config/env.contract');

const baseEnv = () => ({
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
  JWT_SECRET: 'test-jwt-secret',
  REDIS_URL: 'redis://127.0.0.1:6379',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  PORT: '8000',
  NODE_ENV: 'development',
  ORCHESTRATION_ENGINE: 'langgraph',
});

test('validateEnvironmentContract parses valid minimal config', () => {
  const result = validateEnvironmentContract(baseEnv());

  assert.equal(result.config.PORT, 8000);
  assert.equal(result.config.NODE_ENV, 'development');
  assert.equal(result.config.APP_BASE_URL, 'http://localhost:5173');
  assert.equal(result.config.BACKEND_PUBLIC_URL, 'http://localhost:8000');
  assert.equal(result.config.ORCHESTRATION_ENGINE, 'langgraph');
  assert.ok(Array.isArray(result.warnings));
});

test('validateEnvironmentContract fails when DATABASE_URL is missing', () => {
  const env = baseEnv();
  delete env.DATABASE_URL;

  assert.throws(
    () => validateEnvironmentContract(env),
    (error) => {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(error.issues.some((issue) => issue.key === 'DATABASE_URL' && issue.code === 'missing_value'));
      return true;
    },
  );
});

test('validateEnvironmentContract fails on invalid numeric bounds', () => {
  const env = baseEnv();
  env.LOG_SUCCESS_SAMPLE_RATE = '2';

  assert.throws(
    () => validateEnvironmentContract(env),
    (error) => {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(
        error.issues.some((issue) => issue.key === 'LOG_SUCCESS_SAMPLE_RATE' && issue.code === 'out_of_range'),
      );
      return true;
    },
  );
});

test('validateEnvironmentContract fails on invalid orchestration engine', () => {
  const env = baseEnv();
  env.ORCHESTRATION_ENGINE = 'unknown';

  assert.throws(
    () => validateEnvironmentContract(env),
    (error) => {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(error.issues.some((issue) => issue.key === 'ORCHESTRATION_ENGINE' && issue.code === 'invalid_enum'));
      return true;
    },
  );
});

test('validateEnvironmentContract accepts mastra orchestration engine with required fields', () => {
  const env = baseEnv();
  env.ORCHESTRATION_ENGINE = 'mastra';
  env.MASTRA_BASE_URL = 'http://127.0.0.1:4111';
  env.MASTRA_AGENT_ID = 'supervisorAgent';
  env.MASTRA_TIMEOUT_MS = '12000';

  const result = validateEnvironmentContract(env);
  assert.equal(result.config.ORCHESTRATION_ENGINE, 'mastra');
  assert.equal(result.config.MASTRA_AGENT_ID, 'supervisorAgent');
});

test('validateEnvironmentContract enforces production Lark verification guard', () => {
  const env = baseEnv();
  env.NODE_ENV = 'production';
  delete env.LARK_VERIFICATION_TOKEN;
  delete env.LARK_WEBHOOK_SIGNING_SECRET;

  assert.throws(
    () => validateEnvironmentContract(env),
    (error) => {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(
        error.issues.some(
          (issue) => issue.key === 'LARK_VERIFICATION_TOKEN,LARK_WEBHOOK_SIGNING_SECRET' && issue.code === 'missing_verification_config',
        ),
      );
      return true;
    },
  );
});

test('validateEnvironmentContract enforces LARK_APP_ID and LARK_APP_SECRET pairing', () => {
  const env = baseEnv();
  env.LARK_APP_ID = 'cli_xxx';
  delete env.LARK_APP_SECRET;

  assert.throws(
    () => validateEnvironmentContract(env),
    (error) => {
      assert.ok(error instanceof EnvValidationError);
      assert.ok(error.issues.some((issue) => issue.key === 'LARK_APP_ID,LARK_APP_SECRET' && issue.code === 'paired_required'));
      return true;
    },
  );
});

test('validateEnvironmentContract warns for langgraph without OPENAI_API_KEY', () => {
  const env = baseEnv();
  delete env.OPENAI_API_KEY;

  const result = validateEnvironmentContract(env);
  assert.ok(result.warnings.some((issue) => issue.key === 'OPENAI_API_KEY' && issue.code === 'fallback_mode'));
});

test('validateEnvironmentContract accepts deprecated SEPER_API_KEY alias', () => {
  const env = baseEnv();
  env.SEPER_API_KEY = 'serper-key-from-alias';

  const result = validateEnvironmentContract(env);
  assert.equal(result.config.SERPER_API_KEY, 'serper-key-from-alias');
});
