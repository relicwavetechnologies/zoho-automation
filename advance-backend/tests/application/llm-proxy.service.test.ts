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
