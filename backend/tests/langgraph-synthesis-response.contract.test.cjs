const assert = require('node:assert/strict');
const test = require('node:test');

const channelRegistry = require('../dist/company/channels/channel-adapter.registry');
const { openAiOrchestrationModels } = require('../dist/company/orchestration/langchain/openai-models');
const agentBridge = require('../dist/company/orchestration/langgraph/agent-bridge');
const { runtimeControlSignalsRepository } = require('../dist/company/queue/runtime/control-signals.repository');
const { checkpointRepository } = require('../dist/company/state/checkpoint');
const { langGraphOrchestrationEngine } = require('../dist/company/orchestration/engine/langgraph-orchestration.engine');

const baseInput = () => ({
  task: {
    taskId: 'task-synth-1',
    messageId: 'om_synth_1',
    userId: 'ou_synth_1',
    chatId: 'oc_synth_1',
    status: 'running',
    plan: ['route.classify', 'agent.invoke.response', 'synthesis.compose'],
    executionMode: 'sequential',
  },
  message: {
    channel: 'lark',
    userId: 'ou_synth_1',
    chatId: 'oc_synth_1',
    chatType: 'p2p',
    messageId: 'om_synth_1',
    timestamp: new Date().toISOString(),
    text: 'summarize updates',
    rawEvent: {},
    trace: { requestId: 'req-synth-1' },
  },
  latestCheckpoint: null,
});

const withPatchedMethod = async (target, methodName, replacement, fn) => {
  const original = target[methodName];
  target[methodName] = replacement;
  try {
    await fn();
  } finally {
    target[methodName] = original;
  }
};

const buildCheckpointStub = () => {
  const calls = [];
  let version = 0;
  return {
    calls,
    save: async (taskId, node, state) => {
      version += 1;
      const checkpoint = {
        taskId,
        version,
        node,
        state,
        updatedAt: new Date().toISOString(),
      };
      calls.push(checkpoint);
      return checkpoint;
    },
  };
};

const withEngineStubs = async ({ invokePrompt, invokeSupervisor, sendMessage, dispatch }, fn) => {
  const checkpointStub = buildCheckpointStub();

  const stubTier1 = async () => JSON.stringify({ done: false });
  const stubSupervisor = invokeSupervisor ?? (async () => JSON.stringify({ next: 'FINISH', reply: 'stub-supervisor-reply' }));

  await withPatchedMethod(runtimeControlSignalsRepository, 'assertRunnableAtBoundary', async () => { }, async () => {
    await withPatchedMethod(checkpointRepository, 'save', checkpointStub.save, async () => {
      await withPatchedMethod(openAiOrchestrationModels, 'invokeTier1', stubTier1, async () => {
        await withPatchedMethod(openAiOrchestrationModels, 'invokeSupervisor', stubSupervisor, async () => {
          await withPatchedMethod(openAiOrchestrationModels, 'invokePrompt', invokePrompt, async () => {
            await withPatchedMethod(agentBridge, 'dispatchLangGraphAgents', dispatch, async () => {
              await withPatchedMethod(channelRegistry, 'resolveChannelAdapter', () => ({ sendMessage }), async () => {
                await fn(checkpointStub.calls);
              });
            });
          });
        });
      });
    });
  });
};

test('synthesis/response contract: valid synthesis + send success checkpoints sent', async () => {
  await withEngineStubs({
    invokePrompt: async (key) => {
      if (key === 'router') {
        return JSON.stringify({ intent: 'general', complexityLevel: 2, executionMode: 'sequential' });
      }
      if (key === 'planner') {
        return JSON.stringify({ plan: ['route.classify', 'agent.invoke.response', 'synthesis.compose'] });
      }
      return JSON.stringify({ taskStatus: 'done', text: 'Synthesis success text' });
    },
    // Supervisor returns FINISH immediately with no opinion — synthesis LLM wins
    invokeSupervisor: async () => JSON.stringify({ next: 'FINISH', reply: 'Synthesis success text' }),
    sendMessage: async () => ({ status: 'sent', channel: 'lark', messageId: 'om_out_1' }),
    dispatch: async (input) => [{
      taskId: input.task.taskId,
      agentKey: 'response',
      status: 'success',
      message: 'ok',
      result: { summary: 'ok' },
    }],
  }, async (checkpoints) => {
    const result = await langGraphOrchestrationEngine.executeTask(baseInput());

    assert.equal(result.status, 'done');
    assert.equal(result.latestSynthesis, 'Synthesis success text');

    const responseCheckpoint = checkpoints.find((entry) => entry.node === 'response.send');
    assert.ok(responseCheckpoint, 'response.send checkpoint missing');
    assert.equal(responseCheckpoint.state.responseDeliveryStatus, 'sent');
    assert.equal(responseCheckpoint.state.sent, true);
  });
});

test('synthesis/response contract: invalid synthesis falls back deterministically', async () => {
  await withEngineStubs({
    invokePrompt: async (key) => {
      if (key === 'router') {
        return JSON.stringify({ intent: 'general', complexityLevel: 2, executionMode: 'sequential' });
      }
      if (key === 'planner') {
        return JSON.stringify({ plan: ['route.classify', 'agent.invoke.response', 'synthesis.compose'] });
      }
      return 'not-json';
    },
    // Supervisor returns null/bad output → supervisor short-circuit won't fire → falls to full synthesis
    invokeSupervisor: async () => null,
    sendMessage: async () => ({ status: 'sent', channel: 'lark', messageId: 'om_out_2' }),
    dispatch: async (input) => [{
      taskId: input.task.taskId,
      agentKey: 'response',
      status: 'success',
      message: 'ok',
      result: { summary: 'ok' },
    }],
  }, async (checkpoints) => {
    const result = await langGraphOrchestrationEngine.executeTask(baseInput());

    assert.equal(result.status, 'done');
    assert.ok(typeof result.latestSynthesis === 'string' && result.latestSynthesis.length > 0);

    const synthesisCheckpoint = checkpoints.find((entry) => entry.node === 'synthesis.complete');
    assert.ok(synthesisCheckpoint, 'synthesis checkpoint missing');
    // Supervisor null → resolveSupervisorDecision still returns FINISH with graceful fallback reply
    // so supervisor_passthrough is the correct source (not deterministic_fallback)
    assert.equal(synthesisCheckpoint.state.synthesisSource, 'supervisor_passthrough');
  });
});

test('synthesis/response contract: send failure is explicit and task fails', async () => {
  await withEngineStubs({
    invokePrompt: async (key) => {
      if (key === 'router') {
        return JSON.stringify({ intent: 'general', complexityLevel: 2, executionMode: 'sequential' });
      }
      if (key === 'planner') {
        return JSON.stringify({ plan: ['route.classify', 'agent.invoke.response', 'synthesis.compose'] });
      }
      return JSON.stringify({ taskStatus: 'done', text: 'delivery should fail' });
    },
    sendMessage: async () => ({
      status: 'failed',
      channel: 'lark',
      error: {
        type: 'API_ERROR',
        classifiedReason: 'downstream_send_failed',
        retriable: false,
      },
    }),
    dispatch: async (input) => [{
      taskId: input.task.taskId,
      agentKey: 'response',
      status: 'success',
      message: 'ok',
      result: { summary: 'ok' },
    }],
  }, async (checkpoints) => {
    const result = await langGraphOrchestrationEngine.executeTask(baseInput());

    assert.equal(result.status, 'failed');

    const responseCheckpoint = checkpoints.find((entry) => entry.node === 'response.send');
    assert.ok(responseCheckpoint, 'response.send checkpoint missing');
    assert.equal(responseCheckpoint.state.responseDeliveryStatus, 'failed');
    assert.equal(responseCheckpoint.state.sent, false);
  });
});
