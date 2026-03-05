const assert = require('node:assert/strict');
const test = require('node:test');

const { agentRegistry } = require('../dist/company/agents');
const {
  buildLangGraphAgentInvocations,
  dispatchLangGraphAgents,
} = require('../dist/company/orchestration/langgraph/agent-bridge');

const baseTask = {
  taskId: 'task-agent-1',
  messageId: 'om_agent_1',
  userId: 'ou_agent_1',
  chatId: 'oc_agent_1',
  status: 'running',
  plan: ['route.classify', 'agent.invoke.response', 'synthesis.compose'],
  executionMode: 'sequential',
};

const baseMessage = {
  channel: 'lark',
  userId: 'ou_agent_1',
  chatId: 'oc_agent_1',
  chatType: 'p2p',
  messageId: 'om_agent_1',
  timestamp: new Date().toISOString(),
  text: 'hello world',
  rawEvent: {},
  trace: { requestId: 'req-agent-1' },
};

const withPatchedMethod = async (target, methodName, replacement, fn) => {
  const original = target[methodName];
  target[methodName] = replacement;
  try {
    await fn();
  } finally {
    target[methodName] = original;
  }
};

test('agent bridge unknown agent is non-retriable agent_not_registered', async () => {
  const invocations = [{
    taskId: baseTask.taskId,
    agentKey: 'unknown-agent-key',
    objective: baseMessage.text,
    constraints: ['v1-langgraph-runtime'],
    contextPacket: {
      channel: baseMessage.channel,
      chatId: baseMessage.chatId,
      chatType: baseMessage.chatType,
      timestamp: baseMessage.timestamp,
    },
    correlationId: 'corr-unknown-agent',
  }];

  const results = await dispatchLangGraphAgents({
    task: baseTask,
    message: baseMessage,
    invocations,
    attempt: 1,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].error.classifiedReason, 'agent_not_registered');
  assert.equal(results[0].error.retriable, false);
});

test('agent bridge maps retriable failure and success across explicit retry attempts', async () => {
  let callCount = 0;
  await withPatchedMethod(agentRegistry, 'invoke', async (input) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        taskId: input.taskId,
        agentKey: input.agentKey,
        status: 'failed',
        message: 'temporary agent outage',
        error: {
          type: 'TOOL_ERROR',
          classifiedReason: 'temporary_failure',
          retriable: true,
        },
      };
    }

    return {
      taskId: input.taskId,
      agentKey: input.agentKey,
      status: 'success',
      message: 'ok',
      result: { success: true },
    };
  }, async () => {
    const invocations = buildLangGraphAgentInvocations(baseTask, baseMessage);

    const firstAttempt = await dispatchLangGraphAgents({
      task: baseTask,
      message: baseMessage,
      invocations,
      attempt: 1,
    });
    assert.equal(firstAttempt[0].status, 'failed');
    assert.equal(firstAttempt[0].error.classifiedReason, 'agent_retriable_failure');

    const secondAttempt = await dispatchLangGraphAgents({
      task: baseTask,
      message: baseMessage,
      invocations,
      attempt: 2,
    });
    assert.equal(secondAttempt[0].status, 'success');
    assert.equal(secondAttempt[0].metrics.apiCalls, 2);
  });
});

test('agent bridge maps non-retriable failures explicitly', async () => {
  await withPatchedMethod(agentRegistry, 'invoke', async (input) => ({
    taskId: input.taskId,
    agentKey: input.agentKey,
    status: 'failed',
    message: 'hard failure',
    error: {
      type: 'TOOL_ERROR',
      classifiedReason: 'hard_failure',
      retriable: false,
    },
  }), async () => {
    const invocations = buildLangGraphAgentInvocations(baseTask, baseMessage);
    const results = await dispatchLangGraphAgents({
      task: baseTask,
      message: baseMessage,
      invocations,
      attempt: 1,
    });

    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].error.classifiedReason, 'agent_non_retriable_failure');
    assert.equal(results[0].error.retriable, false);
  });
});

test('agent bridge maps thrown exceptions to agent_bridge_exception', async () => {
  await withPatchedMethod(agentRegistry, 'invoke', async () => {
    throw new Error('registry crash');
  }, async () => {
    const invocations = buildLangGraphAgentInvocations(baseTask, baseMessage);
    const results = await dispatchLangGraphAgents({
      task: baseTask,
      message: baseMessage,
      invocations,
      attempt: 1,
    });

    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].error.classifiedReason, 'agent_bridge_exception');
  });
});

test('agent bridge invocation envelope carries task and correlation metadata', () => {
  const invocations = buildLangGraphAgentInvocations(baseTask, baseMessage);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].taskId, baseTask.taskId);
  assert.equal(invocations[0].agentKey, 'response');
  assert.ok(typeof invocations[0].correlationId === 'string' && invocations[0].correlationId.length > 0);
});
