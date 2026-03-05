const assert = require('node:assert/strict');
const test = require('node:test');

process.env.ORCHESTRATION_QUEUE_JOB_TIMEOUT_MS = '1000';
process.env.ORCHESTRATION_WORKER_CONCURRENCY = '3';
process.env.ORCHESTRATION_QUEUE_LOCK_DURATION_MS = '7000';
process.env.ORCHESTRATION_QUEUE_STALLED_INTERVAL_MS = '1500';
process.env.ORCHESTRATION_QUEUE_MAX_STALLED_COUNT = '2';

const { QueueTaskTimeoutError } = require('../dist/company/queue/runtime/queue-safety');
const {
  runOrchestrationJobWithSafety,
  __test__: workerTest,
} = require('../dist/company/queue/runtime/orchestration.worker');

const buildJob = () => ({
  id: 'job-1',
  data: {
    taskId: 'task-1',
    message: {
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
    },
  },
});

test('runOrchestrationJobWithSafety resolves for fast processor', async () => {
  const job = buildJob();
  let invoked = false;

  await runOrchestrationJobWithSafety(job, async () => {
    invoked = true;
  });

  assert.equal(invoked, true);
});

test('runOrchestrationJobWithSafety throws QueueTaskTimeoutError on timeout', async () => {
  const job = buildJob();

  await assert.rejects(
    () => runOrchestrationJobWithSafety(job, async () => new Promise(() => {})),
    (error) => {
      assert.ok(error instanceof QueueTaskTimeoutError);
      assert.equal(error.timeoutMs, 1000);
      assert.equal(error.meta.taskId, 'task-1');
      assert.equal(error.meta.requestId, 'req-1');
      return true;
    },
  );
});

test('worker options are built from env safety knobs', () => {
  const fakeConnection = { __fake: true };
  const options = workerTest.buildWorkerOptions(fakeConnection);

  assert.equal(options.concurrency, 3);
  assert.equal(options.lockDuration, 7000);
  assert.equal(options.stalledInterval, 1500);
  assert.equal(options.maxStalledCount, 2);
  assert.equal(options.connection, fakeConnection);
});
