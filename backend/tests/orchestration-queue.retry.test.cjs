const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../dist/config').default;
const { HttpException } = require('../dist/core/http-exception');
const {
  ORCHESTRATION_QUEUE_NAME,
  __test__: queueTest,
} = require('../dist/company/queue/runtime/orchestration.queue');

const buildMessage = () => ({
  channel: 'lark',
  userId: 'ou_1',
  chatId: 'oc_1',
  chatType: 'p2p',
  messageId: 'om_1',
  timestamp: new Date().toISOString(),
  text: 'hello',
  rawEvent: {},
  trace: {
    requestId: 'req-1',
  },
});

test('queue add options enforce attempts=1 with configured timeout', () => {
  const options = queueTest.buildQueueAddOptions('job-safe-1');

  assert.equal(options.attempts, 1);
  assert.equal(options.timeout, config.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS);
  assert.equal(options.jobId, 'job-safe-1');
});

test('queue name is sanitized for bullmq safety', () => {
  assert.equal(ORCHESTRATION_QUEUE_NAME.includes(':'), false);
});

test('enqueueJobWithRetry retries transient failures and succeeds', async () => {
  let calls = 0;
  const queueAdd = async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error('connection is closed'), {
        code: 'ECONNREFUSED',
      });
    }
    return { id: 'job-1' };
  };

  await queueTest.enqueueJobWithRetry({
    taskId: 'task-1',
    message: buildMessage(),
    jobId: 'job-1',
    queueAdd,
  });

  assert.equal(calls, 2);
});

test('enqueueJobWithRetry throws 503 after exhausting transient retries', async () => {
  let calls = 0;
  const queueAdd = async () => {
    calls += 1;
    throw Object.assign(new Error('redis unavailable'), {
      code: 'ECONNREFUSED',
    });
  };

  await assert.rejects(
    () =>
      queueTest.enqueueJobWithRetry({
        taskId: 'task-2',
        message: buildMessage(),
        jobId: 'job-2',
        queueAdd,
      }),
    (error) => {
      assert.ok(error instanceof HttpException);
      assert.equal(error.status, 503);
      assert.equal(error.message, 'Orchestration queue unavailable');
      return true;
    },
  );

  assert.equal(calls, config.ORCHESTRATION_QUEUE_ADD_MAX_ATTEMPTS);
});

test('enqueueJobWithRetry does not retry non-transient failures', async () => {
  let calls = 0;
  const queueAdd = async () => {
    calls += 1;
    throw new Error('validation failed');
  };

  await assert.rejects(
    () =>
      queueTest.enqueueJobWithRetry({
        taskId: 'task-3',
        message: buildMessage(),
        jobId: 'job-3',
        queueAdd,
      }),
    (error) => {
      assert.ok(error instanceof HttpException);
      assert.equal(error.status, 503);
      return true;
    },
  );

  assert.equal(calls, 1);
});
