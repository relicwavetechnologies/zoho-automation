const assert = require('node:assert/strict');
const test = require('node:test');

const { runtimeTaskStore } = require('../dist/company/orchestration/runtime-task.store');
const workerModule = require('../dist/company/queue/runtime/orchestration.worker');

const buildTask = (taskId) =>
  runtimeTaskStore.create({
    taskId,
    messageId: `om_${taskId}`,
    channel: 'lark',
    userId: 'ou_1',
    chatId: 'oc_1',
    status: 'running',
    plan: ['route.classify'],
  });

test('worker metadata update stores configured and effective engine for langgraph success', { concurrency: 1 }, () => {
  const taskId = 'worker-engine-meta-1';
  buildTask(taskId);

  workerModule.__test__.applyExecutionResultToTask({
    taskId,
    selectedEngine: 'langgraph',
    engineUsed: 'langgraph',
    result: {
      status: 'done',
      task: {
        plan: ['route.classify', 'synthesis.compose'],
        executionMode: 'sequential',
      },
      currentStep: 'synthesis.compose',
      latestSynthesis: 'ok',
      runtimeMeta: {
        threadId: taskId,
        node: 'synthesis.compose',
        stepHistory: ['route.classify', 'synthesis.compose'],
        routeIntent: 'general',
      },
      agentResults: [],
    },
  });

  const snapshot = runtimeTaskStore.get(taskId);
  assert.ok(snapshot);
  assert.equal(snapshot.configuredEngine, 'langgraph');
  assert.equal(snapshot.engineUsed, 'langgraph');
  assert.equal(snapshot.engine, 'langgraph');
  assert.equal(snapshot.rolledBackFrom, undefined);
  assert.equal(snapshot.rollbackReasonCode, undefined);
});

test('worker metadata update stores rollback source and reason when fallback to legacy occurs', { concurrency: 1 }, () => {
  const taskId = 'worker-engine-meta-2';
  buildTask(taskId);

  workerModule.__test__.applyExecutionResultToTask({
    taskId,
    selectedEngine: 'langgraph',
    engineUsed: 'legacy',
    rolledBackFrom: 'langgraph',
    rollbackReasonCode: 'llm_unavailable',
    result: {
      status: 'done',
      task: {
        plan: ['route.classify', 'synthesis.compose'],
        executionMode: 'sequential',
      },
      currentStep: 'synthesis.compose',
      latestSynthesis: 'fallback',
      runtimeMeta: {
        threadId: taskId,
        node: 'synthesis.compose',
        stepHistory: ['route.classify', 'synthesis.compose'],
        routeIntent: 'general',
      },
      agentResults: [],
    },
  });

  const snapshot = runtimeTaskStore.get(taskId);
  assert.ok(snapshot);
  assert.equal(snapshot.configuredEngine, 'langgraph');
  assert.equal(snapshot.engineUsed, 'legacy');
  assert.equal(snapshot.engine, 'legacy');
  assert.equal(snapshot.rolledBackFrom, 'langgraph');
  assert.equal(snapshot.rollbackReasonCode, 'llm_unavailable');
});
