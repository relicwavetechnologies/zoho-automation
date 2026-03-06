const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const configModule = require('../dist/config');
const config = configModule.default || configModule;
const { logger } = require('../dist/utils/logger');
const { emitRuntimeTrace, __test__ } = require('../dist/company/observability/tracing/trace-sink');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const originalConfig = {
  tracing: config.LANGSMITH_TRACING,
  apiKey: config.LANGSMITH_API_KEY,
  project: config.LANGSMITH_PROJECT,
  endpoint: config.LANGSMITH_ENDPOINT,
};

test.after(() => {
  config.LANGSMITH_TRACING = originalConfig.tracing;
  config.LANGSMITH_API_KEY = originalConfig.apiKey;
  config.LANGSMITH_PROJECT = originalConfig.project;
  config.LANGSMITH_ENDPOINT = originalConfig.endpoint;
  __test__.resetSink();
});

test('trace sink stays noop when tracing disabled', async () => {
  config.LANGSMITH_TRACING = false;
  config.LANGSMITH_API_KEY = 'lsv2_test';
  config.LANGSMITH_PROJECT = 'zoho-automation';

  __test__.resetSink();
  assert.equal(__test__.getSinkMode(), 'noop');

  emitRuntimeTrace({
    event: 'runtime.test.disabled',
    level: 'info',
    requestId: 'req-disabled',
    metadata: {
      textHash: 'hash-disabled',
    },
  });

  await sleep(5);
});

test('trace sink falls back to noop when tracing toggle is enabled but key/project are missing', async () => {
  config.LANGSMITH_TRACING = true;
  config.LANGSMITH_API_KEY = '';
  config.LANGSMITH_PROJECT = '';

  const warns = [];
  const originalWarn = logger.warn;
  logger.warn = (message, meta) => {
    warns.push({ message, meta });
  };

  try {
    __test__.resetSink();
    assert.equal(__test__.getSinkMode(), 'noop');

    emitRuntimeTrace({
      event: 'runtime.test.missing_config',
      level: 'info',
      requestId: 'req-missing-config',
    });

    await sleep(5);
    assert.equal(
      warns.some((entry) => entry.message === 'runtime.trace.disabled'),
      true,
    );
  } finally {
    logger.warn = originalWarn;
  }
});

test('trace sink failures are fail-open and warning is emitted once', async () => {
  const warns = [];
  const originalWarn = logger.warn;
  logger.warn = (message, meta) => {
    warns.push({ message, meta });
  };

  try {
    __test__.setSink({
      mode: 'langsmith',
      emit: async () => {
        throw new Error('sink unavailable');
      },
    });

    emitRuntimeTrace({
      event: 'runtime.test.emit_failed_1',
      level: 'info',
      requestId: 'req-fail-open-1',
      metadata: {
        text: 'raw text should be excluded',
      },
    });

    emitRuntimeTrace({
      event: 'runtime.test.emit_failed_2',
      level: 'info',
      requestId: 'req-fail-open-2',
    });

    await sleep(15);
    assert.equal(
      warns.filter((entry) => entry.message === 'runtime.trace.emit_failed').length,
      1,
    );
  } finally {
    logger.warn = originalWarn;
  }
});

test('trace event sanitizer excludes raw text and redacts secrets while preserving safe metadata', () => {
  const sanitized = __test__.sanitizeEvent({
    event: 'runtime.test.sanitize',
    level: 'info',
    occurredAt: '2026-03-05T06:50:00.000Z',
    requestId: 'req-sanitize',
    metadata: {
      text: 'raw',
      prompt_body: 'prompt',
      accessToken: 'secret-token',
      textHash: 'sha256-hash',
      routeIntent: 'zoho_read',
    },
  });

  assert.equal(sanitized.metadata.text, '[EXCLUDED]');
  assert.equal(sanitized.metadata.prompt_body, '[EXCLUDED]');
  assert.equal(sanitized.metadata.accessToken, '[REDACTED]');
  assert.equal(sanitized.metadata.textHash, 'sha256-hash');
  assert.equal(sanitized.metadata.routeIntent, 'zoho_read');
});
