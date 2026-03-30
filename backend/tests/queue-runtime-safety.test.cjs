const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSafeJobId,
  sanitizeQueueName,
  isTransientQueueInfraError,
  withTaskTimeout,
  QueueTaskTimeoutError,
} = require('../dist/company/queue/runtime/queue-safety');

test('buildSafeJobId removes unsupported characters', () => {
  const jobId = buildSafeJobId('lark', 'msg:01', 'team alpha');

  assert.equal(jobId.includes(':'), false);
  assert.equal(jobId.includes(' '), false);
  assert.ok(jobId.startsWith('lark__msg_01__team_alpha'));
});

test('buildSafeJobId produces deterministic fallback when fragments sanitize to empty', () => {
  const jobId = buildSafeJobId('::', '   ', '***');

  assert.match(jobId, /^job_[a-f0-9]{12}$/);
});

test('buildSafeJobId enforces maximum length cap', () => {
  const longPart = 'a'.repeat(220);
  const jobId = buildSafeJobId('lark', longPart);

  assert.equal(jobId.length <= 128, true);
});

test('sanitizeQueueName strips unsupported characters and keeps bullmq-safe names', () => {
  const queueName = sanitizeQueueName('company:orchestration/v1');

  assert.equal(queueName.includes(':'), false);
  assert.equal(queueName.includes('/'), false);
  assert.equal(queueName, 'company_orchestration_v1');
});

test('isTransientQueueInfraError detects known transient infra failures', () => {
  const withCode = Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' });
  const withMessage = new Error('Connection is closed.');

  assert.equal(isTransientQueueInfraError(withCode), true);
  assert.equal(isTransientQueueInfraError(withMessage), true);
  assert.equal(isTransientQueueInfraError(new Error('payload validation failed')), false);
});

test('withTaskTimeout returns result for in-time task', async () => {
  const result = await withTaskTimeout(() => Promise.resolve('ok'), 25, { taskId: 'task-1' });
  assert.equal(result, 'ok');
});

test('withTaskTimeout throws QueueTaskTimeoutError with metadata', async () => {
  await assert.rejects(
    () => withTaskTimeout(() => new Promise(() => {}), 20, { taskId: 'task-timeout', channel: 'lark' }),
    (error) => {
      assert.ok(error instanceof QueueTaskTimeoutError);
      assert.equal(error.timeoutMs, 20);
      assert.equal(error.meta.taskId, 'task-timeout');
      return true;
    },
  );
});
