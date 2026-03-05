const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('../dist/config').default;
const engineModule = require('../dist/company/orchestration/engine');
const { langGraphOrchestrationEngine } = require('../dist/company/orchestration/engine/langgraph-orchestration.engine');
const { legacyOrchestrationEngine } = require('../dist/company/orchestration/engine/legacy-orchestration.engine');
const { HttpException } = require('../dist/core/http-exception');

const baseInput = () => ({
  task: {
    taskId: 'task-engine-test',
    messageId: 'om_engine_test',
    userId: 'ou_1',
    chatId: 'oc_1',
    status: 'running',
    plan: ['route.classify', 'synthesis.compose'],
    executionMode: 'sequential',
  },
  message: {
    channel: 'lark',
    userId: 'ou_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    messageId: 'om_engine_test',
    timestamp: new Date().toISOString(),
    text: 'hello',
    rawEvent: {},
    trace: { requestId: 'req-engine-test' },
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

const withConfig = async (patch, fn) => {
  const prevEngine = config.ORCHESTRATION_ENGINE;
  const prevRollback = config.ORCHESTRATION_LEGACY_ROLLBACK_ENABLED;
  Object.assign(config, patch);
  try {
    await fn();
  } finally {
    config.ORCHESTRATION_ENGINE = prevEngine;
    config.ORCHESTRATION_LEGACY_ROLLBACK_ENABLED = prevRollback;
  }
};

test('engine switch: configured legacy executes legacy only', { concurrency: 1 }, async () => {
  const input = baseInput();

  await withConfig({ ORCHESTRATION_ENGINE: 'legacy', ORCHESTRATION_LEGACY_ROLLBACK_ENABLED: true }, async () => {
    await withPatchedMethod(langGraphOrchestrationEngine, 'executeTask', async () => {
      throw new Error('langgraph should not be called');
    }, async () => {
      await withPatchedMethod(legacyOrchestrationEngine, 'executeTask', async () => ({
        task: input.task,
        status: 'done',
        currentStep: 'synthesis.compose',
        latestSynthesis: 'ok-from-legacy',
        runtimeMeta: { engine: 'legacy', node: 'synthesis.compose', stepHistory: ['synthesis.compose'] },
      }), async () => {
        const envelope = await engineModule.executeTaskWithConfiguredEngine(input);
        assert.equal(envelope.configuredEngine, 'legacy');
        assert.equal(envelope.engineUsed, 'legacy');
        assert.equal(envelope.rolledBackFrom, undefined);
      });
    });
  });
});

test('engine switch: configured langgraph success keeps langgraph', { concurrency: 1 }, async () => {
  const input = baseInput();

  await withConfig({ ORCHESTRATION_ENGINE: 'langgraph', ORCHESTRATION_LEGACY_ROLLBACK_ENABLED: true }, async () => {
    await withPatchedMethod(langGraphOrchestrationEngine, 'executeTask', async () => ({
      task: input.task,
      status: 'done',
      currentStep: 'synthesis.compose',
      latestSynthesis: 'ok-from-langgraph',
      runtimeMeta: { engine: 'langgraph', node: 'synthesis.compose', stepHistory: ['synthesis.compose'] },
    }), async () => {
      const envelope = await engineModule.executeTaskWithConfiguredEngine(input);
      assert.equal(envelope.configuredEngine, 'langgraph');
      assert.equal(envelope.engineUsed, 'langgraph');
      assert.equal(envelope.rolledBackFrom, undefined);
      assert.equal(envelope.rollbackReasonCode, undefined);
    });
  });
});

test('engine switch: eligible langgraph failure rolls back when enabled', { concurrency: 1 }, async () => {
  const input = baseInput();

  await withConfig({ ORCHESTRATION_ENGINE: 'langgraph', ORCHESTRATION_LEGACY_ROLLBACK_ENABLED: true }, async () => {
    await withPatchedMethod(langGraphOrchestrationEngine, 'executeTask', async () => {
      throw new Error('network timeout while calling llm');
    }, async () => {
      await withPatchedMethod(legacyOrchestrationEngine, 'executeTask', async () => ({
        task: input.task,
        status: 'done',
        currentStep: 'synthesis.compose',
        latestSynthesis: 'fallback-legacy',
        runtimeMeta: { engine: 'legacy', node: 'synthesis.compose', stepHistory: ['synthesis.compose'] },
      }), async () => {
        const envelope = await engineModule.executeTaskWithConfiguredEngine(input);
        assert.equal(envelope.configuredEngine, 'langgraph');
        assert.equal(envelope.engineUsed, 'legacy');
        assert.equal(envelope.rolledBackFrom, 'langgraph');
        assert.equal(envelope.rollbackReasonCode, 'llm_unavailable');
      });
    });
  });
});

test('engine switch: eligible langgraph failure does not rollback when disabled', { concurrency: 1 }, async () => {
  const input = baseInput();

  await withConfig({ ORCHESTRATION_ENGINE: 'langgraph', ORCHESTRATION_LEGACY_ROLLBACK_ENABLED: false }, async () => {
    await withPatchedMethod(langGraphOrchestrationEngine, 'executeTask', async () => {
      throw new Error('timeout while calling llm');
    }, async () => {
      await assert.rejects(() => engineModule.executeTaskWithConfiguredEngine(input), /timeout while calling llm/);
    });
  });
});

test('engine switch: non-eligible langgraph failure does not rollback even when enabled', { concurrency: 1 }, async () => {
  const input = baseInput();

  await withConfig({ ORCHESTRATION_ENGINE: 'langgraph', ORCHESTRATION_LEGACY_ROLLBACK_ENABLED: true }, async () => {
    await withPatchedMethod(langGraphOrchestrationEngine, 'executeTask', async () => {
      throw new HttpException(401, 'Unauthorized');
    }, async () => {
      await assert.rejects(
        () => engineModule.executeTaskWithConfiguredEngine(input),
        (error) => {
          assert.ok(error instanceof HttpException);
          assert.equal(error.status, 401);
          return true;
        },
      );
    });
  });
});
