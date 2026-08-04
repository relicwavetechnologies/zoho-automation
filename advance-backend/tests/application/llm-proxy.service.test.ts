import test from 'node:test';
import assert from 'node:assert/strict';

import { LlmProxyService } from '../../src/application/proxy/llm-proxy.service.ts';

const logger = {
  child() { return this; },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

test('allows Luna for an unblocked member without an explicit policy', async () => {
  const service = new LlmProxyService({
    memberProxyPolicy: { findUnique: async () => null },
  } as any, logger);

  assert.deepEqual(
    await service.allowedModelsFor('user-1'),
    ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-luna'],
  );
});

test('records a title completion without creating a visible execution run', async () => {
  let data: Record<string, unknown> | undefined;
  const service = new LlmProxyService({
    aiTokenUsage: {
      create: async (input: { data: Record<string, unknown> }) => {
        data = input.data;
      },
    },
  } as any, logger);

  await service.recordAuxiliaryUsage({
    companyId: 'company-1',
    userId: 'user-1',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    usage: {
      prompt_tokens: 40,
      prompt_cache_hit_tokens: 12,
      completion_tokens: 6,
    },
    agentTarget: 'desktop.thread_title',
    channel: 'desktop',
    threadId: 'thread-1',
  });

  assert.deepEqual(data, {
    companyId: 'company-1',
    userId: 'user-1',
    agentTarget: 'desktop.thread_title',
    modelId: 'deepseek-v4-flash',
    provider: 'deepseek',
    channel: 'desktop',
    mode: 'fast',
    actualInputTokens: 28,
    actualOutputTokens: 6,
    cacheReadInputTokens: 12,
    threadId: 'thread-1',
  });
  assert.equal('executionRunId' in (data ?? {}), false);
});

test('creates Pi execution runs with their authenticated channel provenance', async () => {
  let data: Record<string, unknown> | undefined;
  const service = new LlmProxyService({
    executionRun: {
      findUnique: async () => null,
      create: async (input: { data: Record<string, unknown> }) => {
        data = input.data;
        return { id: 'execution-1' };
      },
    },
  } as any, logger);

  const executionId = await service.ensureRun({
    runId: 'run-1',
    companyId: 'company-1',
    userId: 'user-1',
    channel: 'lark',
  });

  assert.equal(executionId, 'execution-1');
  assert.equal(data?.['channel'], 'lark');
  assert.equal(data?.['entrypoint'], 'pi');
});

test('never persists Shopify arguments or result payloads in proxy execution traces', async () => {
  const events: Record<string, unknown>[] = [];
  const steps: Record<string, unknown>[] = [];
  const service = new LlmProxyService({
    executionRun: { update: async () => ({ lastSequence: 1 }) },
    executionEvent: { upsert: async (input: { create: Record<string, unknown> }) => { events.push(input.create); } },
    stepResult: { upsert: async (input: { create: Record<string, unknown> }) => { steps.push(input.create); } },
  } as any, logger);

  await service.recordToolResults('execution-1', [
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call-1',
        function: {
          name: 'divo',
          arguments: JSON.stringify({
            op: 'tools.invoke',
            payload: { toolId: 'shopifyCustomers', args: { search: { field: 'email', value: 'private@example.test' } } },
          }),
        },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ data: { amountSpent: '999.00', tags: ['vip'] } }) },
  ] as never);

  const persisted = JSON.stringify({ events, steps });
  assert.doesNotMatch(persisted, /private@example\.test|999\.00|vip/);
  assert.match(persisted, /REDACTED: governed Shopify result/);
  assert.match(persisted, /shopifyCustomers/);
});
