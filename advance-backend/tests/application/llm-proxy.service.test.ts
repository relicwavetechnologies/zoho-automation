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
