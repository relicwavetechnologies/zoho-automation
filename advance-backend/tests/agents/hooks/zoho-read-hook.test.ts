import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentHook } from '../../../src/application/orchestration/agent-runners/dynamic/agent-hook.ts';

const baseCtx = {
  agent: {
    id: 'zoho',
    companyId: 'co1',
    slug: 'zoho-ops',
    name: 'Zoho Operations',
    capabilityDescription: 'Zoho',
    toolIds: ['zohoCrm', 'zohoBooks'],
    childAgentIds: [],
    systemPrompt: 'You are Zoho.',
    hookId: 'zoho-read',
    modelId: null,
    provider: null,
    maxSteps: 12,
    temperature: 0,
    isActive: true,
    isRootAgent: false,
    parentId: null,
  },
  ctx: {},
  depth: 0,
  path: [],
} as any;

describe('ZohoReadHook', () => {
  it('adds structured source, limit, and date context before execution', async () => {
    const hook = resolveAgentHook('zoho-read');
    assert.ok(hook?.preExecute);

    const result = await hook.preExecute({
      ...baseCtx,
      task: 'show last 5 deals since January',
    });

    assert.match(result.additionalSystemPrompt ?? '', /"sourceTypes":\["Deal"\]/);
    assert.match(result.additionalSystemPrompt ?? '', /"resultLimit":5/);
    assert.match(result.additionalSystemPrompt ?? '', /"dateRange":"since January"/);
  });

  it('normalizes empty postExecute output', async () => {
    const hook = resolveAgentHook('zoho-read');
    assert.ok(hook?.postExecute);

    const result = await hook.postExecute({ ...baseCtx, task: 'show deals' }, '  ');

    assert.equal(result, 'No Zoho result was returned.');
  });
});
