#!/usr/bin/env node

const IORedis = require('ioredis');
const { randomUUID } = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { orchestratorService } = require('../dist/company/orchestration');
const { agentRegistry } = require('../dist/company/agents');
const { hitlActionService } = require('../dist/company/state/hitl');
const { runWithRetryPolicy } = require('../dist/company/observability');
const { redisConnection } = require('../dist/company/queue/runtime/redis.connection');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const assertCondition = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const run = async () => {
  const report = {
    startedAt: new Date().toISOString(),
    scenarios: [],
    ok: false,
    cleanup: null,
  };

  const redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const cleanupKeys = [];
  const originalLarkResponseAgent = agentRegistry.get('lark-response');

  const step = async (name, fn) => {
    try {
      const detail = await fn();
      report.scenarios.push({
        name,
        status: 'PASS',
        detail,
      });
    } catch (error) {
      report.scenarios.push({
        name,
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  try {
    await step('Ingress-to-response orchestration path (normalized input -> dispatch -> synthesis)', async () => {
      const stubAgent = {
        key: 'lark-response',
        invoke: async (input) => ({
          taskId: input.taskId,
          agentKey: 'lark-response',
          status: 'success',
          message: 'Stubbed lark response delivery',
          result: {
            delivered: true,
          },
          metrics: {
            latencyMs: 1,
            apiCalls: 0,
          },
        }),
      };

      agentRegistry.register(stubAgent);

      const taskId = randomUUID();
      const message = {
        channel: 'lark',
        userId: 'smoke-user',
        chatId: 'smoke-chat',
        chatType: 'group',
        messageId: `smoke-${Date.now()}`,
        timestamp: new Date().toISOString(),
        text: 'show zoho contacts',
        rawEvent: {
          smoke: true,
        },
      };

      const task = await orchestratorService.buildTask(taskId, message);
      const agentResults = await orchestratorService.dispatchAgents(task, message);
      const synthesis = orchestratorService.synthesize(task, message, agentResults);

      assertCondition(task.plan.includes('agent.invoke.zoho-read'), 'Expected zoho-read in orchestration plan');
      assertCondition(
        agentResults.some((item) => item.agentKey === 'lark-response' && item.status === 'success'),
        'Expected lark-response dispatch to succeed',
      );
      assertCondition(
        typeof synthesis.text === 'string' && synthesis.text.trim().length > 0,
        'Expected synthesized response text to be non-empty',
      );
      assertCondition(
        synthesis.taskStatus === 'done' || synthesis.taskStatus === 'failed',
        `Expected synthesized task status to be done or failed, got ${synthesis.taskStatus}`,
      );

      return {
        plan: task.plan,
        agentStatuses: agentResults.map((result) => ({ agentKey: result.agentKey, status: result.status })),
        synthesis: synthesis.text,
        synthesisTaskStatus: synthesis.taskStatus,
      };
    });

    await step('HITL status transition and atomic resolve behavior', async () => {
      const taskId = randomUUID();
      const action = await hitlActionService.createPending({
        taskId,
        actionType: 'execute',
        summary: 'Smoke HITL action',
        chatId: 'smoke-chat',
      });

      const actionKey = `emiac:hitl:action:${action.actionId}`;
      const taskKey = `emiac:task:${taskId}:hitl:action`;
      cleanupKeys.push(actionKey, taskKey);

      const waitPromise = hitlActionService.waitForResolution(action.actionId);
      await sleep(100);
      const resolved = await hitlActionService.resolveByActionId(action.actionId, 'confirmed');
      const waited = await waitPromise;
      const secondResolve = await hitlActionService.resolveByActionId(action.actionId, 'cancelled');

      assertCondition(resolved === true, 'Expected first HITL resolve to succeed');
      assertCondition(waited.action.status === 'confirmed', 'Expected waitForResolution to observe confirmed status');
      assertCondition(secondResolve === false, 'Expected second HITL resolve to fail due to atomic status transition');

      return {
        actionId: action.actionId,
        finalStatus: waited.action.status,
        secondResolve,
      };
    });

    await step('Retry path classification and bounded retry execution', async () => {
      let attempt = 0;

      const result = await runWithRetryPolicy({
        maxAttempts: 3,
        baseDelayMs: 1,
        run: async () => {
          attempt += 1;
          if (attempt < 2) {
            throw new Error('network timeout');
          }
          return {
            ok: true,
          };
        },
        shouldRetry: (_candidateResult, candidateError) => {
          if (!candidateError) {
            return false;
          }
          const message = candidateError instanceof Error ? candidateError.message.toLowerCase() : String(candidateError).toLowerCase();
          return message.includes('timeout') || message.includes('network');
        },
      });

      assertCondition(result.attempts === 2, `Expected 2 attempts, got ${result.attempts}`);

      return {
        attempts: result.attempts,
      };
    });

    report.ok = true;
  } catch {
    report.ok = false;
  } finally {
    if (originalLarkResponseAgent) {
      agentRegistry.register(originalLarkResponseAgent);
    }

    try {
      if (cleanupKeys.length > 0) {
        await redis.del(...cleanupKeys);
      }
      report.cleanup = {
        redisKeysDeleted: cleanupKeys.length,
      };
    } catch (error) {
      report.cleanup = {
        error: error instanceof Error ? error.message : String(error),
      };
      report.ok = false;
    }

    await redis.quit();
    await redisConnection.disconnect().catch(() => undefined);
    report.finishedAt = new Date().toISOString();
  }

  return report;
};

run()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  })
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
