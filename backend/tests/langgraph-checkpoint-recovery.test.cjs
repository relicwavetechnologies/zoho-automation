const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decideCheckpointRecovery,
} = require('../dist/company/orchestration/langgraph/checkpoint-recovery');
const { adminRuntimeService } = require('../dist/modules/admin-runtime/admin-runtime.service');
const { checkpointRepository } = require('../dist/company/state/checkpoint');
const { hitlActionRepository } = require('../dist/company/state/hitl/hitl-action.repository');
const { orchestrationRuntime } = require('../dist/company/queue/runtime');

const withPatchedMethod = async (target, methodName, replacement, fn) => {
  const original = target[methodName];
  target[methodName] = replacement;
  try {
    await fn();
  } finally {
    target[methodName] = original;
  }
};

const checkpointStateBase = {
  channel: 'lark',
  userId: 'ou_recover_1',
  chatId: 'oc_recover_1',
  chatType: 'p2p',
  messageId: 'om_recover_1',
  timestamp: new Date().toISOString(),
  text: 'recover this task',
  trace: {
    requestId: 'req-recover-1',
    eventId: 'evt-recover-1',
    textHash: 'hash-recover',
    receivedAt: new Date().toISOString(),
  },
};

test('checkpoint recovery: synthesis complete resumes without duplicate send', () => {
  const decision = decideCheckpointRecovery({
    latestCheckpoint: {
      taskId: 'task-r1',
      version: 10,
      node: 'synthesis.complete',
      state: {
        ...checkpointStateBase,
        status: 'done',
        text: 'already synthesized',
      },
      updatedAt: new Date().toISOString(),
    },
  });

  assert.equal(decision.recoveryMode, 'resume_from_checkpoint');
  assert.equal(decision.shouldReturnCompleted, true);
  assert.equal(decision.resumeDecisionReason, 'synthesis_complete_no_duplicate_send');
});

test('checkpoint recovery: response send with sent=true finalizes only', () => {
  const decision = decideCheckpointRecovery({
    latestCheckpoint: {
      taskId: 'task-r2',
      version: 11,
      node: 'response.send',
      state: {
        ...checkpointStateBase,
        sent: true,
        status: 'done',
      },
      updatedAt: new Date().toISOString(),
    },
  });

  assert.equal(decision.recoveryMode, 'resume_from_checkpoint');
  assert.equal(decision.shouldFinalizeOnly, true);
  assert.equal(decision.shouldReturnCompleted, false);
});

test('checkpoint recovery: hitl requested + pending action resumes waiting path', () => {
  const decision = decideCheckpointRecovery({
    latestCheckpoint: {
      taskId: 'task-r3',
      version: 12,
      node: 'hitl.requested',
      state: {
        ...checkpointStateBase,
        actionId: '11111111-1111-1111-1111-111111111111',
      },
      updatedAt: new Date().toISOString(),
    },
    hasPendingHitlAction: true,
  });

  assert.equal(decision.recoveryMode, 'resume_from_checkpoint');
  assert.equal(decision.shouldReusePendingHitlAction, true);
});

test('checkpoint recovery: mid-agent dispatch requeues from start', () => {
  const decision = decideCheckpointRecovery({
    latestCheckpoint: {
      taskId: 'task-r4',
      version: 13,
      node: 'agent.dispatch.complete',
      state: {
        ...checkpointStateBase,
      },
      updatedAt: new Date().toISOString(),
    },
  });

  assert.equal(decision.recoveryMode, 'requeue_from_start');
  assert.equal(decision.shouldReturnCompleted, false);
  assert.equal(decision.shouldFinalizeOnly, false);
});

test('admin recover returns mode/reason and skips requeue when already completed', async () => {
  const latest = {
    taskId: 'task-admin-r1',
    version: 21,
    node: 'synthesis.complete',
    state: {
      ...checkpointStateBase,
      status: 'done',
      text: 'final output',
    },
    updatedAt: new Date().toISOString(),
  };

  let requeueCount = 0;
  await withPatchedMethod(checkpointRepository, 'getLatest', async () => latest, async () => {
    await withPatchedMethod(hitlActionRepository, 'getByTaskId', async () => null, async () => {
      await withPatchedMethod(orchestrationRuntime, 'requeue', async () => {
        requeueCount += 1;
      }, async () => {
        const result = await adminRuntimeService.recoverTask('task-admin-r1');
        assert.equal(result.recoveryMode, 'resume_from_checkpoint');
        assert.equal(result.resumeDecisionReason, 'synthesis_complete_no_duplicate_send');
        assert.equal(result.status, 'already_completed');
        assert.equal(requeueCount, 0);
      });
    });
  });
});

test('admin recover requeues and preserves trace when pending hitl action exists', async () => {
  const latest = {
    taskId: 'task-admin-r2',
    version: 22,
    node: 'hitl.requested',
    state: {
      ...checkpointStateBase,
      actionId: '22222222-2222-2222-2222-222222222222',
    },
    updatedAt: new Date().toISOString(),
  };

  let capturedMessage;
  await withPatchedMethod(checkpointRepository, 'getLatest', async () => latest, async () => {
    await withPatchedMethod(hitlActionRepository, 'getByTaskId', async () => ({
      taskId: latest.taskId,
      actionId: latest.state.actionId,
      actionType: 'execute',
      summary: 'pending action',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      status: 'pending',
    }), async () => {
      await withPatchedMethod(orchestrationRuntime, 'requeue', async (_taskId, message) => {
        capturedMessage = message;
      }, async () => {
        const result = await adminRuntimeService.recoverTask('task-admin-r2');
        assert.equal(result.recoveryMode, 'resume_from_checkpoint');
        assert.equal(result.resumeDecisionReason, 'resume_waiting_existing_hitl_action');
        assert.equal(result.status, 'requeued');
        assert.equal(capturedMessage.trace.requestId, checkpointStateBase.trace.requestId);
        assert.equal(capturedMessage.trace.eventId, checkpointStateBase.trace.eventId);
      });
    });
  });
});
