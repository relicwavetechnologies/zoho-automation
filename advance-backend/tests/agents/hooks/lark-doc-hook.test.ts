import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentHook } from '../../../src/application/orchestration/agent-runners/dynamic/agent-hook.ts';

const baseCtx = {
  agent: {
    id: 'lark-doc',
    companyId: 'co1',
    slug: 'lark-doc',
    name: 'Lark Doc',
    capabilityDescription: 'Docs',
    toolIds: ['larkDoc'],
    childAgentIds: [],
    systemPrompt: 'You are Lark Doc.',
    hookId: 'lark-doc',
    modelId: null,
    provider: null,
    maxSteps: 8,
    temperature: 0,
    isActive: true,
    isRootAgent: false,
    parentId: null,
  },
  ctx: {},
  depth: 0,
  path: [],
} as any;

describe('LarkDocHook', () => {
  it('infers append strategy for document update tasks', async () => {
    const hook = resolveAgentHook('lark-doc');
    assert.ok(hook?.preExecute);

    const result = await hook.preExecute({
      ...baseCtx,
      task: 'append meeting notes to Project Plan doc',
    });

    assert.match(result.additionalSystemPrompt ?? '', /Operation: update/);
    assert.match(result.additionalSystemPrompt ?? '', /Edit strategy: append/);
  });

  it('cleans excessive markdown whitespace after execution', async () => {
    const hook = resolveAgentHook('lark-doc');
    assert.ok(hook?.postExecute);

    const result = await hook.postExecute({ ...baseCtx, task: 'read doc' }, 'Title   \n\n\nBody\n');

    assert.equal(result, 'Title\n\nBody');
  });
});
